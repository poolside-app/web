// =============================================================================
// payment_schedule.ts — milestone-driven installment plans
// =============================================================================
// Clubs don't think in "N equal payments". They think in deadlines tied to the
// season: "we need 75% of dues in hand by the day we open in April, and the
// balance by July." That is a constraint, not a schedule — and it's the right
// shape, because it lets a member choose how they'd like to pay while the club
// still gets the cash flow it needs to open the gates.
//
// So the club configures MILESTONES and the member picks a payment COUNT; this
// module produces a schedule that satisfies the milestones by construction,
// and independently validates any schedule before money is scheduled against it.
//
// Config lives at settings.value.payments.plan:
//   {
//     "enabled": true,
//     "milestones": [
//       { "date": "04-01", "min_pct": 75,  "label": "Pool opens" },
//       { "date": "07-01", "min_pct": 100, "label": "Paid in full" }
//     ],
//     "min_installment_cents": 2500,
//     "max_installments": 12
//   }
//
// A milestone date may be "MM-DD" (resolved against the membership year, so a
// club configures "April 1" once and it works every season) or a full
// "YYYY-MM-DD" when a board wants to pin one specific year.
// =============================================================================

export type Milestone = { date: string; min_pct: number; label?: string };
export type Installment = { sequence: number; due_date: string; amount_cents: number };

export type ScheduleRules = {
  milestones: Milestone[];
  minInstallmentCents: number;
  maxInstallments: number;
};

const DEFAULT_MIN_INSTALLMENT_CENTS = 2500;   // $25 — below this the card fees eat it
const DEFAULT_MAX_INSTALLMENTS = 12;

/**
 * Normalize a club's plan config into concrete, sorted, absolute-dated rules
 * for one membership year.
 *
 * Falls back to the legacy two-installment fields (season_open_date /
 * first_installment_pct / final_due_date) so clubs configured before
 * milestones existed keep working untouched.
 */
export function resolveRules(planConfig: Record<string, unknown> | undefined, year: number): ScheduleRules {
  const raw = Array.isArray(planConfig?.milestones)
    ? (planConfig!.milestones as Milestone[])
    : legacyMilestones(planConfig);

  const milestones = raw
    .map(m => ({
      date: absoluteDate(String(m.date ?? ''), year),
      min_pct: clamp(Number(m.min_pct), 1, 100),
      label: m.label ? String(m.label) : undefined,
    }))
    .filter(m => !!m.date)
    .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  // A plan has to end at 100% or the member never actually finishes paying.
  if (milestones.length && milestones[milestones.length - 1].min_pct < 100) {
    milestones[milestones.length - 1].min_pct = 100;
  }

  return {
    milestones,
    minInstallmentCents: posInt(planConfig?.min_installment_cents, DEFAULT_MIN_INSTALLMENT_CENTS),
    maxInstallments: clamp(posInt(planConfig?.max_installments, DEFAULT_MAX_INSTALLMENTS), 2, 24),
  };
}

/**
 * Build a schedule of `count` payments that meets every milestone.
 *
 * The trick that makes this always-valid rather than search-and-retry: each
 * milestone owns the slice of the total between it and the previous one, and
 * that slice is spread only across payment dates that fall on or before it. A
 * milestone therefore cannot be missed — the money for it is, by construction,
 * scheduled before its date.
 *
 * Cents are distributed largest-remainder style so the parts always sum to the
 * exact total. A member paying $600 over 7 payments should never see the club
 * quietly round its way to $600.03.
 */
export function generateSchedule(args: {
  totalCents: number;
  rules: ScheduleRules;
  count: number;
  startDate: string;          // 'YYYY-MM-DD' — usually today
}): { ok: true; installments: Installment[] } | { ok: false; error: string } {
  const { totalCents, rules, startDate } = args;
  if (totalCents <= 0) return { ok: false, error: 'Nothing to pay.' };
  if (!rules.milestones.length) return { ok: false, error: 'This club has not set up payment deadlines yet.' };

  const count = clamp(Math.trunc(args.count), 1, rules.maxInstallments);
  const finalDate = rules.milestones[rules.milestones.length - 1].date;
  if (startDate > finalDate) {
    return { ok: false, error: 'The payment window for this season has already closed.' };
  }

  const dates = paymentDates(startDate, finalDate, count);

  // Slice the total by milestone, then spread each slice over the dates that
  // land inside that milestone's window.
  const out: Installment[] = dates.map((d, i) => ({ sequence: i + 1, due_date: d, amount_cents: 0 }));
  let prevPct = 0;
  let allocated = 0;

  for (let mi = 0; mi < rules.milestones.length; mi++) {
    const m = rules.milestones[mi];
    const isLast = mi === rules.milestones.length - 1;
    const slice = isLast
      ? totalCents - allocated                                   // exact remainder; no rounding drift
      : Math.round(totalCents * (m.min_pct - prevPct) / 100);

    const idx = out
      .map((inst, i) => ({ i, d: inst.due_date }))
      .filter(x => x.d <= m.date && out[x.i].amount_cents === 0)
      .map(x => x.i);

    // No unfilled date inside this window (e.g. the member picked one payment
    // and it lands after the first milestone) — fold the slice into the next
    // window rather than failing; validation below still has the last word.
    if (!idx.length) { if (!isLast) continue; }

    const targets = idx.length ? idx : [out.length - 1];
    for (const [k, amount] of splitCents(slice, targets.length).entries()) {
      out[targets[k]].amount_cents += amount;
    }
    allocated += slice;
    prevPct = m.min_pct;
  }

  // Drop any date that ended up with nothing so the member isn't shown a $0 row.
  const installments = out
    .filter(i => i.amount_cents > 0)
    .map((inst, i) => ({ ...inst, sequence: i + 1 }));

  const check = validateSchedule({ installments, rules, totalCents });
  if (!check.ok) return { ok: false, error: check.violations[0] };
  return { ok: true, installments };
}

/**
 * Independently confirm a schedule is payable and meets the club's rules.
 * Generation is trusted; anything arriving from a browser is not.
 */
export function validateSchedule(args: {
  installments: Installment[];
  rules: ScheduleRules;
  totalCents: number;
}): { ok: true } | { ok: false; violations: string[] } {
  const { installments, rules, totalCents } = args;
  const violations: string[] = [];

  if (!installments.length) violations.push('Pick at least one payment.');
  if (installments.length > rules.maxInstallments) {
    violations.push(`This club allows at most ${rules.maxInstallments} payments.`);
  }

  const sum = installments.reduce((n, i) => n + i.amount_cents, 0);
  if (sum !== totalCents) {
    violations.push(`Payments add up to ${money(sum)}, but dues are ${money(totalCents)}.`);
  }

  for (const inst of installments) {
    if (inst.amount_cents < rules.minInstallmentCents) {
      violations.push(`Each payment needs to be at least ${money(rules.minInstallmentCents)}.`);
      break;
    }
  }

  for (let i = 1; i < installments.length; i++) {
    if (installments[i].due_date < installments[i - 1].due_date) {
      violations.push('Payment dates have to run in order.');
      break;
    }
  }

  // The milestones themselves — phrased as the shortfall, so the member is told
  // what to change rather than merely that they're wrong.
  for (const m of rules.milestones) {
    const paidBy = installments
      .filter(i => i.due_date <= m.date)
      .reduce((n, i) => n + i.amount_cents, 0);
    const need = Math.round(totalCents * m.min_pct / 100);
    if (paidBy < need) {
      const label = m.label ? `${m.label} (${m.date})` : m.date;
      violations.push(
        `You'd have ${money(paidBy)} paid by ${label}; this club needs ${money(need)} — ${m.min_pct}% — by then. Add ${money(need - paidBy)} earlier.`,
      );
    }
  }

  return violations.length ? { ok: false, violations } : { ok: true };
}

/** Payment counts worth offering, given how much runway is left this season. */
export function suggestedCounts(rules: ScheduleRules, startDate: string): number[] {
  if (!rules.milestones.length) return [];
  const final = rules.milestones[rules.milestones.length - 1].date;
  const months = monthsBetween(startDate, final);
  const most = clamp(months + 1, 1, rules.maxInstallments);
  return [...new Set([2, 3, 4, 6, most])].filter(n => n >= 2 && n <= most).sort((a, b) => a - b);
}

// ── internals ───────────────────────────────────────────────────────────────

/**
 * Payment dates: monthly, on the same day of the month the member started,
 * with the last one landing exactly on the final deadline.
 *
 * Evenly dividing the milliseconds between two dates is simpler but produces
 * things like "2027-03-17" — nobody budgets around the 17th. People pay bills
 * monthly, so the schedule should look like the rest of their life.
 */
function paymentDates(start: string, final: string, count: number): string[] {
  if (count <= 1) return [final];

  const [sy, sm, sd] = start.split('-').map(Number);
  const slots: string[] = [];
  for (let y = sy, m = sm; ; ) {
    const d = onDay(y, m, sd);
    if (d > final) break;
    slots.push(d);
    m++; if (m > 12) { m = 1; y++; }
    if (slots.length > 60) break;   // guard against a nonsense config
  }
  // The final deadline is always a payment date; everything else is a monthly
  // slot leading up to it.
  if (slots[slots.length - 1] !== final) slots.push(final);

  if (count >= slots.length) return slots;

  // Fewer payments than months available: spread them across the runway and
  // always keep the last slot, so the plan still finishes on the deadline.
  const picked: string[] = [];
  const step = (slots.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) picked.push(slots[Math.round(i * step)]);
  return [...new Set(picked)];
}

/** Clamp a day to a real date in that month (Jan 31 -> Feb 28). */
function onDay(year: number, month: number, day: number): string {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const d = Math.min(day, last);
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Split cents into n parts that sum exactly, biggest remainders first. */
function splitCents(total: number, n: number): number[] {
  if (n <= 0) return [];
  const base = Math.floor(total / n);
  const out = new Array(n).fill(base);
  let left = total - base * n;
  for (let i = 0; left > 0; i++, left--) out[i % n] += 1;
  return out;
}

function legacyMilestones(planConfig: Record<string, unknown> | undefined): Milestone[] {
  const out: Milestone[] = [];
  const open = planConfig?.season_open_date as string | undefined;
  const pct = Number(planConfig?.first_installment_pct);
  if (open && Number.isFinite(pct)) out.push({ date: open, min_pct: pct, label: 'Season opens' });
  const final = planConfig?.final_due_date as string | undefined;
  if (final) out.push({ date: final, min_pct: 100, label: 'Paid in full' });
  return out;
}

/** 'MM-DD' resolves against the membership year; a full date passes through. */
function absoluteDate(raw: string, year: number): string {
  const v = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  if (/^\d{2}-\d{2}$/.test(v)) return `${year}-${v}`;
  return '';
}

function monthsBetween(a: string, b: string): number {
  const [ay, am] = a.split('-').map(Number);
  const [by, bm] = b.split('-').map(Number);
  return Math.max(0, (by - ay) * 12 + (bm - am));
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.trunc(n)));
}
function posInt(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

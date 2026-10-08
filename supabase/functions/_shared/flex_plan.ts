// =============================================================================
// flex_plan.ts — the family picks the plan (PLAN.md M, Doug 2026-10-07)
// =============================================================================
// A family pays in full, or chooses two things: how much to pay today (any
// amount, $0 included) and the month they want to be paid off by. The rest is
// split evenly across monthly charges between now and then, in whole cents,
// with the last payment absorbing the rounding so it adds up exactly.
//
// The club's deadlines (payment_schedule.ts milestones: "half by April 10",
// "paid in full by July 15") are checked, not built in. When an even split
// would miss one, the plan is refused with the reason and the least the family
// must pay today to make it work. A deadline already behind the start date is
// due today, so a late joiner pays at least that share up front.
//
// Pure, so it can be tested without a database (scripts/test_flex_plan.mjs).
// =============================================================================

import { dueFrom, type Installment, type ScheduleRules } from './payment_schedule.ts';

export type FlexCheck = {
  date: string; label: string; pct: number;
  need_cents: number; paid_cents: number; ok: boolean;
  /** The club's own date, before a passed deadline was moved to today. */
  club_date: string;
};

export type FlexOk = {
  ok: true;
  today_cents: number;
  /** The monthly charges, after today. */
  payments: Installment[];
  /** Today (when more than $0) and then the monthly charges, numbered from 1. */
  schedule: Installment[];
  checks: FlexCheck[];
  payoff_date: string;
};
export type FlexError = {
  ok: false;
  code: 'no_rules' | 'nothing' | 'closed' | 'full' | 'today_too_small' | 'bad_month' | 'payment_too_small' | 'misses_deadline';
  error: string;
  /** For misses_deadline: the least to pay today that works. */
  min_today_cents?: number;
  checks?: FlexCheck[];
};
export type FlexResult = FlexOk | FlexError;

/** The day of the month the family is charged: the day they signed up, the
 *  28th at most so every month has it. */
export function chargeDay(startDate: string): number {
  return Math.min(Number(startDate.slice(8, 10)) || 1, 28);
}

/** The months a family can choose to be paid off by: next month through the
 *  month of the paid-in-full date, no more than the club's payment limit. */
export function payoffMonths(rules: ScheduleRules, startDate: string): string[] {
  const final = finalDate(rules);
  if (!final || startDate >= final) return [];
  const out: string[] = [];
  let [y, m] = startDate.split('-').map(Number);
  const finalMonth = final.slice(0, 7);
  for (let i = 0; i < 60; i++) {
    m++; if (m > 12) { m = 1; y++; }
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym > finalMonth) break;
    out.push(ym);
    if (out.length >= rules.maxInstallments) break;
  }
  return out;
}

/** Monthly charge dates from next month through the payoff month, on the
 *  family's charge day, never after the paid-in-full date. */
export function monthlyDates(rules: ScheduleRules, startDate: string, payoffMonth: string): string[] {
  const final = finalDate(rules)!;
  const day = chargeDay(startDate);
  return payoffMonths(rules, startDate)
    .filter(ym => ym <= payoffMonth)
    .map(ym => {
      const d = `${ym}-${String(day).padStart(2, '0')}`;
      return d > final ? final : d;
    });
}

export function flexSchedule(args: {
  totalCents: number;
  todayCents: number;
  payoffMonth: string;          // 'YYYY-MM'
  startDate: string;            // pool date 'YYYY-MM-DD'
  rules: ScheduleRules;
}): FlexResult {
  const { totalCents, startDate, rules } = args;
  const today = Math.trunc(Number(args.todayCents) || 0);
  const final = finalDate(rules);
  const min = rules.minInstallmentCents;

  if (!final) return { ok: false, code: 'no_rules', error: 'This club has not set up its payment deadlines yet.' };
  if (!(totalCents > 0)) return { ok: false, code: 'nothing', error: 'There is nothing to pay.' };
  const months = payoffMonths(rules, startDate);
  if (!months.length) {
    return { ok: false, code: 'closed', error: `Payment plans had to be paid off by ${longDate(final)}, so only paying in full is available now.` };
  }
  if (today >= totalCents) return { ok: false, code: 'full', error: 'That is the whole amount. Choose "Pay in full" instead.' };
  if (today < 0 || (today > 0 && today < min)) {
    return { ok: false, code: 'today_too_small', error: `Pay $0 today, or at least ${money(min)}.` };
  }
  if (!months.includes(args.payoffMonth)) {
    return { ok: false, code: 'bad_month', error: `Choose a month from ${monthName(months[0])} to ${monthName(months[months.length - 1])}.` };
  }

  const dates = monthlyDates(rules, startDate, args.payoffMonth);
  const payments = evenSplit(totalCents - today, dates);
  if (payments[0].amount_cents < min) {
    return {
      ok: false, code: 'payment_too_small',
      error: totalCents - today < min
        ? `Pay in full, or pay less today so at least ${money(min)} is left for later.`
        : `Each monthly payment has to be at least ${money(min)}. Choose an earlier payoff month.`,
    };
  }

  const schedule = number([
    ...(today > 0 ? [{ sequence: 0, due_date: startDate, amount_cents: today }] : []),
    ...payments,
  ]);
  const checks = checkDeadlines(rules, startDate, totalCents, schedule);
  const miss = checks.find(c => !c.ok);
  if (miss) {
    const need = leastToday(rules, startDate, totalCents, dates, today);
    const passed = miss.club_date < startDate;
    const share = shareText(miss.pct, miss.need_cents);
    const error = need >= totalCents
      ? `${share} ${passed ? 'was' : 'is'} due by ${longDate(miss.club_date)}, so this plan can't work. Choose "Pay in full".`
      : passed
        ? `${share} was due by ${longDate(miss.club_date)}, so at least ${money(need)} is due today.`
        : `${share} has to be paid by ${longDate(miss.club_date)}. This plan would have ${money(miss.paid_cents)} paid by then. Pay at least ${money(need)} today, or choose an earlier payoff month.`;
    return { ok: false, code: 'misses_deadline', error, min_today_cents: Math.min(need, totalCents), checks };
  }

  return {
    ok: true,
    today_cents: today,
    payments: number(payments).map((p, i) => ({ ...p, sequence: i + 1 })),
    schedule,
    checks,
    payoff_date: dates[dates.length - 1],
  };
}

/** What each charge comes to with the plan fee (to Poolside) and, when the
 *  club passes card fees on, the card fee grossed up on top. The dues part
 *  (amount_cents) is untouched, so it still adds up to the price. */
export function withFees<T extends { amount_cents: number }>(
  rows: T[],
  opts: { planFees: number[]; passFee: boolean; pct: number; fixed: number },
): Array<T & { plan_fee_cents: number; card_fee_cents: number; charge_cents: number }> {
  return rows.map((r, i) => {
    const planFee = Math.max(0, Math.trunc(opts.planFees[i] ?? 0));
    const base = r.amount_cents + planFee;
    const gross = opts.passFee && base > 0 ? Math.ceil((base + opts.fixed) / (1 - opts.pct)) : base;
    return { ...r, plan_fee_cents: planFee, card_fee_cents: gross - base, charge_cents: gross };
  });
}

export type AccessRule = 'card' | 'first_payment' | 'half_paid';
export const ACCESS_RULES: AccessRule[] = ['card', 'first_payment', 'half_paid'];

/** Whether a plan family may have the gate and their key fob yet. Doug chose
 *  half paid for Bishop (2026-10-07); the club can pick. */
export function accessReady(
  rule: string | null | undefined,
  s: { paidCents: number; totalCents: number; cardSaved: boolean },
): boolean {
  if (rule === 'card') return s.cardSaved;
  if (rule === 'first_payment') return s.paidCents > 0;
  return s.paidCents * 2 >= s.totalCents;
}

// ── internals ───────────────────────────────────────────────────────────────

function finalDate(rules: ScheduleRules): string | null {
  return rules.milestones.length ? rules.milestones[rules.milestones.length - 1].date : null;
}

/** Equal payments in whole cents; the last one absorbs the rounding. */
function evenSplit(cents: number, dates: string[]): Installment[] {
  const n = dates.length;
  const base = Math.floor(cents / n);
  return dates.map((d, i) => ({
    sequence: i + 1, due_date: d,
    amount_cents: i === n - 1 ? cents - base * (n - 1) : base,
  }));
}

function number(rows: Installment[]): Installment[] {
  return rows.map((r, i) => ({ ...r, sequence: i + 1 }));
}

function checkDeadlines(rules: ScheduleRules, startDate: string, totalCents: number, schedule: Installment[]): FlexCheck[] {
  const moved = dueFrom(rules, startDate).milestones;
  return moved.map((m, i) => {
    const need = Math.round(totalCents * m.min_pct / 100);
    const paid = schedule.filter(s => s.due_date <= m.date).reduce((n, s) => n + s.amount_cents, 0);
    return {
      date: m.date, club_date: rules.milestones[i].date,
      label: m.label ?? (m.min_pct >= 100 ? 'Paid in full' : `${m.min_pct}% paid`),
      pct: m.min_pct, need_cents: need, paid_cents: paid, ok: paid >= need,
    };
  });
}

/**
 * The least to pay today, keeping the same monthly dates, so every deadline
 * is met. Worked out from the deadline's share and then confirmed, because
 * whole-cent rounding can leave it a few cents short. Rounded up to a whole
 * dollar so the number is one a person would type.
 */
function leastToday(rules: ScheduleRules, startDate: string, totalCents: number, dates: string[], from: number): number {
  const passes = (t: number) => {
    if (t >= totalCents) return true;
    const sched = [{ sequence: 1, due_date: startDate, amount_cents: t }, ...evenSplit(totalCents - t, dates)];
    return checkDeadlines(rules, startDate, totalCents, sched).every(c => c.ok);
  };
  const n = dates.length;
  let t = from;
  for (const m of dueFrom(rules, startDate).milestones) {
    const k = dates.filter(d => d <= m.date).length;
    if (k >= n) continue;   // every payment is in by then
    const need = Math.round(totalCents * m.min_pct / 100);
    t = Math.max(t, Math.ceil((n * need - k * totalCents) / (n - k)));
  }
  t = Math.max(t, rules.minInstallmentCents);
  t = Math.ceil(t / 100) * 100;
  while (t < totalCents && !passes(t)) t += 100;
  return Math.min(t, totalCents);
}

function shareText(pct: number, cents: number): string {
  if (pct >= 100) return `The full ${money(cents)}`;
  if (pct === 50) return `Half the dues (${money(cents)})`;
  return `${pct}% of the dues (${money(cents)})`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}
function monthName(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

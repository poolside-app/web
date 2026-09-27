// =============================================================================
// pricing.ts — what a membership costs after discounts (PLAN.md H5–H7)
// =============================================================================
// Doug, 2026-09-26:
//   - One discount per membership. A new family who joins through a member's
//     link saves the referral discount ($25 by default); a family with a code
//     saves what the code says. If they have both, the bigger one applies and
//     they're told so.
//   - A referring member's earned credit comes off their own dues on top of
//     that, and never takes the price below $0 (a free membership is the cap).
//
// Pure, so the rules can be tested without a database. The database side
// (finding a code, checking a referral, storing the price on the application)
// is in membership_price.ts.
// =============================================================================

export type DiscountCode = {
  id: string;
  code: string;
  label?: string | null;
  amount_cents?: number | null;
  percent_off?: number | null;
  expires_on?: string | null;   // 'YYYY-MM-DD', last day it works (pool time)
  max_uses?: number | null;
  active?: boolean | null;
};

export type Price = {
  base_cents: number;
  discount_cents: number;
  discount_kind: 'code' | 'referral' | null;
  discount_code_id: string | null;
  credit_cents: number;
  amount_due_cents: number;
  /** Shown to the family when a code and the referral discount competed. */
  note: string | null;
};

export const REFERRAL_DEFAULTS = { reward_cents: 10000, new_family_cents: 2500, wait_days: 30 };

/** settings.value.referrals, with Doug's defaults: $100 reward, $25 off, 30 days. */
export function referralSettings(settingsValue: unknown): { reward_cents: number; new_family_cents: number; wait_days: number } {
  const r = ((settingsValue ?? {}) as Record<string, unknown>).referrals as Record<string, unknown> | undefined;
  const cents = (v: unknown, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : d;
  };
  return {
    reward_cents: cents(r?.reward_cents, REFERRAL_DEFAULTS.reward_cents),
    new_family_cents: cents(r?.new_family_cents, REFERRAL_DEFAULTS.new_family_cents),
    wait_days: REFERRAL_DEFAULTS.wait_days,
  };
}

/** "early bird " → "EARLYBIRD". Codes are typed on phones. */
export function normalizeCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

/** Why a code can't be used today, or null if it can. `uses` counts families who paid with it. */
export function codeProblem(code: DiscountCode | null | undefined, today: string, uses: number): string | null {
  if (!code) return "That code isn't valid. Check the spelling.";
  if (code.active === false) return "That code isn't active any more.";
  if (code.expires_on && today > code.expires_on) return `That code ended on ${plainDate(code.expires_on)}.`;
  if (code.max_uses && uses >= code.max_uses) return 'That code has been used up.';
  return null;
}

/** Cents a code takes off this price, never more than the price. */
export function codeOffCents(code: DiscountCode | null | undefined, baseCents: number): number {
  if (!code) return 0;
  const base = Math.max(0, Math.trunc(baseCents));
  const off = code.amount_cents != null
    ? Math.trunc(Number(code.amount_cents))
    : Math.round(base * Number(code.percent_off ?? 0) / 100);
  return Math.max(0, Math.min(base, off || 0));
}

export function priceMembership(args: {
  baseCents: number;
  code?: DiscountCode | null;
  referralOffCents?: number;
  creditCents?: number;
}): Price {
  const base = Math.max(0, Math.trunc(Number(args.baseCents) || 0));
  const codeOff = codeOffCents(args.code, base);
  const refOff = Math.max(0, Math.min(base, Math.trunc(Number(args.referralOffCents) || 0)));

  // The bigger discount wins. A tie goes to the referral, since the family
  // came in through a member's link.
  let kind: Price['discount_kind'] = null;
  let discount = 0;
  if (codeOff > refOff) { kind = 'code'; discount = codeOff; }
  else if (refOff > 0) { kind = 'referral'; discount = refOff; }

  let note: string | null = null;
  if (codeOff > 0 && refOff > 0) {
    note = kind === 'code'
      ? `Your code saves ${money(codeOff)}, more than the ${money(refOff)} referral discount, so the code is used. It's one discount per membership.`
      : `The ${money(refOff)} referral discount saves more than your code (${money(codeOff)}), so it's used. It's one discount per membership.`;
  }

  const after = base - discount;
  const credit = Math.max(0, Math.min(after, Math.trunc(Number(args.creditCents) || 0)));
  return {
    base_cents: base,
    discount_cents: discount,
    discount_kind: kind,
    discount_code_id: kind === 'code' && args.code ? args.code.id : null,
    credit_cents: credit,
    amount_due_cents: after - credit,
    note,
  };
}

export function money(cents: number): string {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? String(d) : d.toFixed(2));
}

function plainDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[m - 1]} ${d}, ${y}`;
}

// =============================================================================
// fees.ts — the platform's cut, in one place
// =============================================================================
// Poolside takes an `application_fee_amount` on Stripe Connect payments: the
// money lands in the club's own account and this slice comes to us.
//
// Consolidated 2026-09-08. The dues rate had been written in FOUR places —
// FEE_BPS_DUES in stripe_checkout, plus three bare `* 0.005` literals in
// payment_plans (one per installment path). Raising the rate in the constant
// alone would have left every installment charging the old number, and
// nothing would have flagged it: the money would simply have been lower than
// intended for the clubs paying in instalments.
//
// Basis points, so the rates read the way they are quoted: 100 bps = 1%.
// =============================================================================

export const FEE_BPS = {
  /** Dues: application full-pay, renewals, and every plan installment.
   *  Raised 0.5% -> 1% on 2026-09-08, before club #2 — raising a rate on
   *  clubs that already signed is far harder than setting it now. */
  dues: 100,
  /** Programs, swim lessons, parties, guest passes. Smaller, more
   *  discretionary amounts, so they carry a higher rate. */
  programs: 150,
  /** Donations take nothing. Skimming a donation to a club looks bad and
   *  earns little. */
  donations: 0,
  /** Late fees and payment-plan reactivation. The highest rate we charge,
   *  and still a small line in absolute terms — a club collecting $750 of
   *  late fees across a season sends us under $40. That is the right size:
   *  the return on late fees is the dues arriving at all, which is where the
   *  1% lives. Taking a meaningful share of a penalty charged to a family
   *  that is already behind is not a business worth being in, and a board
   *  that noticed would switch the feature off. Published on /pricing.html
   *  as 5% — change both together. */
  late: 500,
  /** Safety net for a kind we do not recognise — err on the known-good
   *  higher rate rather than silently taking nothing. */
  default: 150,
} as const;

export type FeeKind = keyof typeof FEE_BPS;

/**
 * The platform's cut in cents. Floors rather than rounds, so we never take
 * more than the quoted rate; a sub-cent difference is not worth the argument.
 */
export function platformFeeCents(amountCents: number, kind: FeeKind): number {
  const bps = FEE_BPS[kind] ?? FEE_BPS.default;
  return Math.max(0, Math.floor((Number(amountCents) || 0) * bps / 10000));
}

// ── Payment-plan convenience fee ─────────────────────────────────────────
// Members who choose to spread dues over the season pay a small fee for the
// convenience, the way they would for an instalment plan on insurance or a
// utility bill. The CLUB is not charged it and its books are unaffected:
// installments keep amount_cents as the pure dues portion, and the fee rides
// alongside as plan_fee_cents. The member pays dues + fee; the fee is added
// to application_fee_amount, so it reaches the platform rather than the club.
//
// Capped per plan, which matters: without a cap an 8-instalment plan at a
// flat $4 would take $32 on $600 of dues — over 5%, which is the sort of
// number that makes a board tell its members to pay by cheque instead.

/** Fee per instalment, before the per-plan cap. */
export const PLAN_FEE_CENTS = 400;
/** Most any single plan can be charged, however many instalments it has. */
export const PLAN_FEE_MAX_CENTS = 1600;

/**
 * Per-instalment fee for a plan of `n` instalments, spread as evenly as
 * cents allow with any remainder on the first payment.
 *
 * Returns one entry per instalment, so callers store it per row rather than
 * recomputing — a plan's fee must not change if the constants later do.
 */
export function planFeeSchedule(n: number): number[] {
  const count = Math.max(0, Math.trunc(n));
  if (count <= 1) return count === 1 ? [0] : [];   // paying once is not a plan
  const total = Math.min(count * PLAN_FEE_CENTS, PLAN_FEE_MAX_CENTS);
  const base = Math.floor(total / count);
  const out = new Array(count).fill(base);
  out[0] += total - base * count;                  // remainder on payment 1
  return out;
}

/** What the whole plan costs the member in fees. For disclosure. */
export function planFeeTotal(n: number): number {
  return planFeeSchedule(n).reduce((a, b) => a + b, 0);
}

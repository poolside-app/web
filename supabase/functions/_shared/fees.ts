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

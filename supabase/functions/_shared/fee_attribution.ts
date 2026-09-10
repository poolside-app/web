// =============================================================================
// fee_attribution.ts — turning a Stripe Application Fee into "earned, on what"
// =============================================================================
// Split out of provider_metrics so the arithmetic can be tested without Stripe
// or a database. It is the only place that decides how much of a fee we
// actually kept and which bucket it belongs in, and getting it wrong misstates
// revenue quietly rather than loudly.
// =============================================================================

/** Buckets shown on the provider revenue table, in display order. */
export const FEE_BUCKETS = [
  'dues', 'plan_fees', 'programs', 'parties', 'guest_passes', 'donations', 'uncategorized',
] as const;
export type FeeBucket = typeof FEE_BUCKETS[number];

/**
 * charge.metadata.kind → bucket. The payment-plan kinds are all dues; the
 * member's plan fee is split back out of them separately, because it rides
 * inside the same application_fee_amount.
 */
export const KIND_BUCKET: Record<string, FeeBucket> = {
  application:               'dues',
  payment_plan_first:        'dues',
  payment_plan_installment:  'dues',
  payment_plan_reactivation: 'dues',
  program_booking:           'programs',
  party_booking:             'parties',
  guest_pass_pack:           'guest_passes',
  donation:                  'donations',
};

export function emptyBuckets(): Record<FeeBucket, number> {
  return { dues: 0, plan_fees: 0, programs: 0, parties: 0, guest_passes: 0, donations: 0, uncategorized: 0 };
}

export type StripeApplicationFee = {
  amount?: number;
  amount_refunded?: number;
  account?: string;
  charge?: { metadata?: Record<string, string> } | string | null;
};

export type Attribution = {
  account: string;
  bucket: FeeBucket;
  /** Net of refunds, excluding the plan-fee portion. */
  bucketCents: number;
  /** Net of refunds, the member-paid plan fee portion. */
  planFeeCents: number;
  grossCents: number;
  refundedCents: number;
  netCents: number;
};

/**
 * What we kept from one Application Fee, and what it was for.
 *
 * Two things worth stating plainly:
 *
 *  · Net, never gross. amount_refunded covers refunds and disputes, both of
 *    which take the fee back. Reporting gross would overstate revenue in
 *    exactly the cases someone is most likely to be checking.
 *
 *  · The plan-fee portion is scaled by the refund ratio rather than taken off
 *    the top. Refund half a charge and we keep half the plan fee, so charging
 *    the whole plan fee against a half-refunded payment would push the dues
 *    portion negative on small amounts.
 */
export function attributeFee(fee: StripeApplicationFee): Attribution {
  const gross    = Math.max(0, Number(fee.amount ?? 0));
  const refunded = Math.max(0, Number(fee.amount_refunded ?? 0));
  const net      = Math.max(0, gross - refunded);

  const meta = (fee.charge && typeof fee.charge === 'object' ? fee.charge.metadata : null) ?? {};
  const bucket = KIND_BUCKET[String(meta.kind ?? '')] ?? 'uncategorized';

  const planGross = Math.max(0, Number(meta.fee_plan_cents ?? 0));
  const planFeeCents = gross > 0 && planGross > 0
    ? Math.min(net, Math.round(net * Math.min(planGross, gross) / gross))
    : 0;

  return {
    account: String(fee.account ?? ''),
    bucket,
    bucketCents: net - planFeeCents,
    planFeeCents,
    grossCents: gross,
    refundedCents: refunded,
    netCents: net,
  };
}

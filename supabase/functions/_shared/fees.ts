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
// intended for the clubs paying in installments.
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
   *  that noticed would switch the feature off.
   *
   *  NOT ON A COLLECTION PATH YET (2026-09-09). late_fees rows are assessed
   *  and tracked, but nothing charges one through Stripe — a club collects
   *  it however it collects dues and marks it paid. So this rate currently
   *  earns nothing, and it is deliberately NOT published on /fees.html:
   *  advertising a rate that cannot be charged is worse than omitting it.
   *  Wire it into the dues checkout (an outstanding fee should ride along
   *  with the payment it is late on, not be a separate errand), then add
   *  the row to the public table. */
  late: 500,
  /** Safety net for a kind we do not recognize — err on the known-good
   *  higher rate rather than silently taking nothing. */
  default: 150,
} as const;

export type FeeKind = keyof typeof FEE_BPS;

// ── Fee policy ───────────────────────────────────────────────────────────
// Some clubs pay us nothing. Bishop Estates is the founder's own club and he
// sits on its board, so billing it a percentage of its own dues is a conflict
// of interest; the waiver makes "take nothing" an explicit, audited state.
//
// Every fee function below takes a policy and it is REQUIRED, deliberately.
// This is a money path that cannot be exercised in test — Stripe is not live —
// so the failure mode to design against is a call site that quietly keeps
// charging after a waiver is granted. An omitted policy therefore throws:
// a 500 that nobody can pay through is recoverable and loud, whereas silently
// billing a club we promised not to bill is neither.
//
// Belt and braces: stripe_checkout and payment_plans also clamp
// application_fee_amount to 0 at the point it is handed to Stripe. Correct at
// each site AND clamped at the boundary, because being wrong here costs
// somebody real money and there is no test that would catch it.

export type FeePolicy = {
  /** Take nothing at all: dues, programs, parties, passes, plan fees. */
  waived: boolean;
};

/** The ordinary case. Named so call sites read as a decision, not a default. */
export const FEES_NORMAL: FeePolicy = { waived: false };

/** Build a policy from a tenants row the caller has already fetched. */
export function feePolicyFromTenant(
  tenant: { platform_fees_waived?: boolean | null } | null | undefined,
): FeePolicy {
  return { waived: !!tenant?.platform_fees_waived };
}

/**
 * Look the policy up when the caller does not already hold the tenant row.
 *
 * Fails CLOSED — on any error we charge nothing rather than risk charging a
 * club that was promised nothing. Under-charging is a bookkeeping problem;
 * over-charging a club that has a written waiver is a broken promise.
 */
export async function feePolicyFor(
  sb: { from: (t: string) => any },
  tenantId: string,
): Promise<FeePolicy> {
  try {
    const { data, error } = await sb.from('tenants')
      .select('platform_fees_waived').eq('id', tenantId).maybeSingle();
    if (error) {
      console.error('feePolicyFor: lookup failed, defaulting to waived:', error.message);
      return { waived: true };
    }
    return feePolicyFromTenant(data);
  } catch (e) {
    console.error('feePolicyFor: threw, defaulting to waived:', (e as Error).message);
    return { waived: true };
  }
}

function requirePolicy(policy: FeePolicy, fn: string): FeePolicy {
  if (!policy || typeof policy.waived !== 'boolean') {
    throw new Error(
      `${fn}: a FeePolicy is required. Resolve it with feePolicyFor(sb, tenantId) ` +
      `or feePolicyFromTenant(row) — never assume the club is billable.`,
    );
  }
  return policy;
}

/**
 * The platform's cut in cents. Floors rather than rounds, so we never take
 * more than the quoted rate; a sub-cent difference is not worth the argument.
 */
export function platformFeeCents(amountCents: number, kind: FeeKind, policy: FeePolicy): number {
  if (requirePolicy(policy, 'platformFeeCents').waived) return 0;
  const bps = FEE_BPS[kind] ?? FEE_BPS.default;
  return Math.max(0, Math.floor((Number(amountCents) || 0) * bps / 10000));
}

// ── Payment-plan convenience fee ─────────────────────────────────────────
// Members who choose to spread dues over the season pay a small fee for the
// convenience, the way they would for an installment plan on insurance or a
// utility bill. The CLUB is not charged it and its books are unaffected:
// installments keep amount_cents as the pure dues portion, and the fee rides
// alongside as plan_fee_cents. The member pays dues + fee; the fee is added
// to application_fee_amount, so it reaches the platform rather than the club.
//
// Capped per plan, which matters: without a cap an 8-installment plan at a
// flat $4 would take $32 on $600 of dues — over 5%, which is the sort of
// number that makes a board tell its members to pay by check instead.

/** Fee per installment, before the per-plan cap. */
export const PLAN_FEE_CENTS = 400;
/** Most any single plan can be charged, however many installments it has. */
export const PLAN_FEE_MAX_CENTS = 1600;

/**
 * Per-installment fee for a plan of `n` installments, spread as evenly as
 * cents allow with any remainder on the first payment.
 *
 * Returns one entry per installment, so callers store it per row rather than
 * recomputing — a plan's fee must not change if the constants later do.
 */
export function planFeeSchedule(n: number, policy: FeePolicy): number[] {
  const count = Math.max(0, Math.trunc(n));
  // A waived club's members pay nothing to spread their dues. Return a
  // correctly-sized array of zeros rather than an empty one, so callers that
  // index per installment still line up.
  if (requirePolicy(policy, 'planFeeSchedule').waived) return new Array(Math.max(0, count)).fill(0);
  if (count <= 1) return count === 1 ? [0] : [];   // paying once is not a plan
  const total = Math.min(count * PLAN_FEE_CENTS, PLAN_FEE_MAX_CENTS);
  const base = Math.floor(total / count);
  const out = new Array(count).fill(base);
  out[0] += total - base * count;                  // remainder on payment 1
  return out;
}

/** What the whole plan costs the member in fees. For disclosure. */
export function planFeeTotal(n: number, policy: FeePolicy): number {
  return planFeeSchedule(n, policy).reduce((a, b) => a + b, 0);
}

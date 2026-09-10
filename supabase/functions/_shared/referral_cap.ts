// =============================================================================
// referral_cap.ts — never credit a member more than their own membership
// =============================================================================
// Refer enough neighbors and your season is free. Refer more and the club does
// not start owing you money.
//
// The arithmetic is small but it decides how much of a club's revenue is given
// away, so it lives here where it can be tested rather than inline in a Deno
// handler that needs a database to run.
// =============================================================================

export type CapState = {
  /** Price of this household's own membership, in cents. */
  dues_cents: number;
  /** Everything already granted to them, across both reward types. */
  awarded_cents: number;
  remaining_cents: number;
  /** True when the club has no priced tiers, so there is nothing to cap against. */
  uncapped: boolean;
};

export function capState(duesCents: number, awardedCents: number): CapState {
  const dues = Math.max(0, Math.trunc(Number(duesCents) || 0));
  const awarded = Math.max(0, Math.trunc(Number(awardedCents) || 0));
  // No priced tiers means the club is not collecting dues through Poolside, so
  // "up to the price of a membership" has nothing to measure. Let rewards
  // through rather than blocking them on missing configuration.
  if (dues <= 0) return { dues_cents: 0, awarded_cents: awarded, remaining_cents: 0, uncapped: true };
  return {
    dues_cents: dues,
    awarded_cents: awarded,
    remaining_cents: Math.max(0, dues - awarded),
    uncapped: false,
  };
}

/**
 * What this claim is actually worth.
 *
 * Partial rather than all-or-nothing: a member sitting on $550 of a $600 cap
 * who refers one more neighbor gets the last $50, not nothing. Refusing it
 * outright would punish them for referring too well, which is the opposite of
 * the point.
 */
export function grantableReward(cap: CapState, offeredCents: number): number {
  const offered = Math.max(0, Math.trunc(Number(offeredCents) || 0));
  if (cap.uncapped) return offered;
  return Math.min(offered, Math.max(0, cap.remaining_cents));
}

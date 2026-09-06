// =============================================================================
// membership_year.ts — which season is the club currently selling?
// =============================================================================
// One answer, in one place. Before this, nine call sites each did
// `new Date().getFullYear()`, which silently assumes people pay during the
// season they are paying for. That assumption breaks exactly when a club wants
// it most: selling next summer in December, so families can spread the cost
// over the off-season instead of taking one large hit at opening.
//
// The rule: a club sells the current calendar year until its renewal window
// opens, then it sells the next one. A board that wants manual control can pin
// `membership.year` and ignore the window entirely.
//
// Settings live in `settings.value.membership`:
//   {
//     "year": 2027,               // optional hard override; wins over everything
//     "renewal_opens_month": 12,  // 1-12, default 12 — when next season goes on sale
//     "renewal_open": true        // optional kill switch for the member-facing button
//   }
// =============================================================================

export type MembershipSettings = {
  year?: number | null;
  renewal_opens_month?: number | null;
  renewal_open?: boolean | null;
};

/** Pull the membership block out of a tenant's settings.value blob. */
export function membershipSettings(settingsValue: unknown): MembershipSettings {
  const v = (settingsValue ?? {}) as Record<string, unknown>;
  return (v.membership as MembershipSettings) ?? {};
}

/**
 * The season a payment made right now should buy.
 *
 * Defaults to December so that "pay for next summer starting in December" works
 * out of the box; a club that opens renewals in October only has to move one
 * number. `now` is injectable so tests can pin a date rather than wait for one.
 */
export function sellingYear(settingsValue: unknown, now: Date = new Date()): number {
  const m = membershipSettings(settingsValue);

  // An explicit year is the board saying "I know what I'm doing" — obey it.
  const pinned = Number(m.year);
  if (Number.isFinite(pinned) && pinned > 2000) return Math.trunc(pinned);

  const openMonth = clampMonth(m.renewal_opens_month, 12);
  const year = now.getUTCFullYear();
  // getUTCMonth is 0-based; +1 puts it on the same footing as the setting.
  return (now.getUTCMonth() + 1) >= openMonth ? year + 1 : year;
}

/**
 * Whether a member can start a renewal today. Distinct from `sellingYear`,
 * because a club may want next year's number settled internally before it
 * shows a "Renew" button to 150 families. Defaults to open — an unconfigured
 * club should still be able to take money.
 */
export function renewalOpen(settingsValue: unknown, now: Date = new Date()): boolean {
  const m = membershipSettings(settingsValue);
  if (m.renewal_open === false) return false;
  if (m.renewal_open === true) return true;
  // Unset: open once we are selling a year the member cannot already have paid
  // for through the normal in-season flow.
  return sellingYear(settingsValue, now) > now.getUTCFullYear();
}

/**
 * Has this household already paid for the season being sold?
 * `paid_until_year` is the last season covered, so equal counts as paid.
 */
export function isPaidThrough(
  paidUntilYear: number | null | undefined,
  year: number,
): boolean {
  return typeof paidUntilYear === 'number' && paidUntilYear >= year;
}

function clampMonth(raw: unknown, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(12, Math.max(1, Math.trunc(n)));
}

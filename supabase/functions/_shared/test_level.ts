// =============================================================================
// test_level.ts — the board's $1 test level (PLAN.md BN1, BK5)
// =============================================================================
// Doug, 10/21: "i want to test paymens like $1 weekly... i'm willing to pay
// for these tests"; 11/1: "lets do weekly". A membership level the board adds
// on Money → Payments to check real card payments with real money: $5, paid
// $1 today and then $1 a week for 4 weeks (plan_quote.ts), each payment still
// ticked on Money → Upcoming.
//
// It's a stored level marked `test`, so every price lookup treats it like a
// real one. Families never see it: the join form shows it only from its own
// link (?level=board_test), and only someone using a board login's email
// (anything after a + ignored) or phone can join on it.
// =============================================================================

export const TEST_LEVEL = {
  slug: 'board_test',
  label: 'Test: $1 a week (board only)',
  price_cents: 500,
  description: 'Checks real card payments: $1 today, then $1 a week for 4 weeks.',
  test: true,
};

export const NOT_BOARD = 'This test level is only for the club\'s board. Use your board email; you can add +test before the @.';

type Tier = { slug?: unknown; test?: unknown } & Record<string, unknown>;

export const isTestTier = (t: Tier | null | undefined): boolean => !!t && t.test === true;

/** Whether this slug is one of the club's test levels. */
export function isTestSlug(tiers: unknown, slug: unknown): boolean {
  const list = Array.isArray(tiers) ? tiers as Tier[] : [];
  return !!slug && list.some(t => t && t.slug === slug && isTestTier(t));
}

/** The levels families see. A test level only from its own link. */
export function publicTiers(tiers: unknown, level?: unknown): Tier[] {
  const list = Array.isArray(tiers) ? tiers as Tier[] : [];
  return list.filter(t => t && (!isTestTier(t) || (!!level && t.slug === level)));
}

/** One inbox: case aside, and anything after a + before the @. */
export function sameInbox(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => {
    const s = String(v ?? '').trim().toLowerCase();
    const at = s.lastIndexOf('@');
    if (at < 1) return '';
    return s.slice(0, at).replace(/\+.*$/, '') + s.slice(at);
  };
  const x = norm(a);
  return !!x && x === norm(b);
}

/** Someone using a board login's email or phone. */
export function boardMatch(
  admins: Array<{ email?: string | null; phone_e164?: string | null }>,
  who: { email?: string | null; phone?: string | null },
): boolean {
  return admins.some(a => (!!a.email && sameInbox(who.email, a.email)) || (!!a.phone_e164 && !!who.phone && a.phone_e164 === who.phone));
}

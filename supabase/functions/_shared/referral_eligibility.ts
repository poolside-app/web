// =============================================================================
// referral_eligibility.ts — who a referral counts for (PLAN.md BJ5)
// =============================================================================
// Doug's walkthrough list, 10/21: a referral counts only if the new family
// wasn't a member last season. A family that lapsed two or more seasons ago
// counts; last season's members (and this season's) don't. "Last season" is
// the one before the season they're signing up for.
//
// A family matches a past household by any phone, email or its street address
// (tidied, so "14 Willow Ln." is "14 Willow Lane"), against households paid
// through last season or later. The same rule takes the $25 off at signup
// (membership_price) and gives the referring member their reward
// (referrals). The family is told the rule, never what matched; the board
// sees the match and can count it anyway.
// =============================================================================

// deno-lint-ignore no-explicit-any
type SB = any;

export const FAMILY_MESSAGE = "The referral discount is for families who weren't members here last season, so it isn't on your price.";

const WORDS: Record<string, string> = {
  street: 'st', avenue: 'ave', av: 'ave', court: 'ct', drive: 'dr', lane: 'ln', road: 'rd', boulevard: 'blvd',
  circle: 'cir', place: 'pl', terrace: 'ter', parkway: 'pkwy', highway: 'hwy', trail: 'trl', way: 'way',
  north: 'n', south: 's', east: 'e', west: 'w', apartment: 'apt', unit: 'apt', suite: 'ste', '#': 'apt',
};
/** A street address in one form: lower case, no punctuation, the usual short words. */
export function normalizeAddress(a: string | null | undefined): string {
  return String(a ?? '').toLowerCase().replace(/#/g, ' # ').replace(/[.,]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => WORDS[w] ?? w).join(' ');
}
const digits = (p: string) => String(p ?? '').replace(/\D/g, '').slice(-10);

export type PastHousehold = { family_name: string; paid_until_year: number; address: string | null; emails: string[]; phones: string[] };
export type Applicant = { emails: Array<string | null | undefined>; phones: Array<string | null | undefined>; address: string | null | undefined };
export type Match = { family: string; season: number; by: 'phone' | 'email' | 'address' };

/** The household from last season (or since) this family matches, or null. */
export function matchLastSeason(app: Applicant, households: PastHousehold[], lastSeason: number): Match | null {
  const emails = new Set(app.emails.map(e => String(e ?? '').trim().toLowerCase()).filter(e => e.includes('@')));
  const phones = new Set(app.phones.map(p => digits(p ?? '')).filter(p => p.length === 10));
  const addr = normalizeAddress(app.address);
  for (const h of households) {
    if (Number(h.paid_until_year ?? 0) < lastSeason) continue;
    const m = (by: Match['by']): Match => ({ family: h.family_name, season: Number(h.paid_until_year), by });
    if (h.phones.some(p => phones.has(digits(p)))) return m('phone');
    if (h.emails.some(e => emails.has(String(e ?? '').trim().toLowerCase()))) return m('email');
    if (addr && normalizeAddress(h.address) === addr) return m('address');
  }
  return null;
}

/** What the board sees: "Member in 2026: same address as the Smith Family". */
export function boardReason(m: Match): string {
  const fam = /family$/i.test(m.family) ? m.family : `${m.family} family`;
  return `Member in ${m.season}: same ${m.by} as the ${fam}`;
}

/** From the database: the households paid through last season or later
 *  (not `exceptHousehold`, the family's own once they're approved), and the
 *  match, if any. */
export async function lastSeasonMember(sb: SB, tenantId: string, app: Applicant, lastSeason: number, exceptHousehold?: string | null): Promise<Match | null> {
  let q = sb.from('households').select('id, family_name, paid_until_year, address')
    .eq('tenant_id', tenantId).gte('paid_until_year', lastSeason);
  if (exceptHousehold) q = q.neq('id', exceptHousehold);
  const { data: hhs } = await q.limit(5000);
  if (!hhs?.length) return null;
  const ids = hhs.map((h: { id: string }) => h.id);
  const people: Array<{ household_id: string; email: string | null; phone_e164: string | null }> = [];
  for (let i = 0; i < ids.length; i += 300) {
    const { data } = await sb.from('household_members').select('household_id, email, phone_e164').in('household_id', ids.slice(i, i + 300));
    people.push(...(data ?? []));
  }
  const past: PastHousehold[] = hhs.map((h: Record<string, unknown>) => ({
    family_name: String(h.family_name ?? 'a member family'), paid_until_year: Number(h.paid_until_year), address: (h.address as string | null) ?? null,
    emails: people.filter(p => p.household_id === h.id && p.email).map(p => p.email as string),
    phones: people.filter(p => p.household_id === h.id && p.phone_e164).map(p => p.phone_e164 as string),
  }));
  return matchLastSeason(app, past, lastSeason);
}

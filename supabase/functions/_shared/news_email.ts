// =============================================================================
// news_email.ts — announcements by email to families no pop-up reached
// =============================================================================
// PLAN.md CM4, Doug 11/8: a family that picked "Just sign me up", or never
// turned pop-ups on, never saw club news; announcements were pop-ups only
// (his 10/7 rule). When the board posts with "Notify members", every current
// family that no pop-up reached gets it by email ("Message from the club"),
// one email per family, to the person who opened the membership.
//
// It goes through the email queue (_shared/email_budget.ts): what today's
// email limit allows goes now, the rest with the next morning's daily run.
// =============================================================================

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one

export type NewsRecipient = { household_id: string; family_name: string; email: string };

/** Current families none of whose people a pop-up reached, with an email. */
export async function newsRecipients(sb: Db, tenantId: string, reachedMemberIds: string[]): Promise<NewsRecipient[]> {
  const [{ data: hhs }, { data: people }] = await Promise.all([
    sb.from('households').select('id, family_name, active').eq('tenant_id', tenantId).eq('active', true),
    sb.from('household_members').select('id, household_id, role, active, email').eq('tenant_id', tenantId).eq('active', true),
  ]);
  const reached = new Set(reachedMemberIds);
  const ppl = (people ?? []) as Array<Record<string, unknown>>;
  const reachedHh = new Set(ppl.filter(p => reached.has(String(p.id))).map(p => String(p.household_id)));
  const seen = new Set<string>();
  const out: NewsRecipient[] = [];
  for (const h of (hhs ?? []) as Array<Record<string, unknown>>) {
    const id = String(h.id);
    if (reachedHh.has(id)) continue;
    const prim = ppl.find(p => String(p.household_id) === id && p.role === 'primary' && p.email);
    const email = String(prim?.email ?? '').trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    out.push({ household_id: id, family_name: String(h.family_name ?? ''), email });
  }
  return out;
}

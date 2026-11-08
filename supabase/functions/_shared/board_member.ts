// =============================================================================
// board_member.ts — a board login and a family member who are the same person
// =============================================================================
// One person, matched by the board login's link (linked_member_id) or the
// same mobile number. Never by email, and never the rest of their family
// (PLAN.md CN4, Doug 11/8: "If it's a family Membership, the family shouldn't
// have board access.. So track that by the phone number"): a spouse who
// shares the board member's email gets nothing from it.
//
// Used so one switch on one phone turns on both board and member pop-ups
// (PLAN.md AH2), for the family side's "Board tools", and to link a board
// login to its person (PLAN.md CN): at the invite, when they open the board,
// and when their family is approved. Linked, the board side shows "Member
// view" and the setup list stops asking them to sign up their family.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one

/** Active board logins that are this family member. */
export async function adminsForMember(sb: SupabaseClient, tenantId: string,
  member: { id: string; phone_e164?: string | null }): Promise<string[]> {
  const or = [`linked_member_id.eq.${member.id}`];
  if (member.phone_e164) or.push(`phone_e164.eq.${member.phone_e164}`);
  const { data } = await sb.from('admin_users').select('id')
    .eq('tenant_id', tenantId).eq('active', true).or(or.join(',')).limit(5);
  return (data ?? []).map(a => a.id as string);
}

/** Active family members who are this board login. */
export async function membersForAdmin(sb: SupabaseClient, tenantId: string,
  admin: { linked_member_id?: string | null; phone_e164?: string | null }): Promise<Array<{ id: string; household_id: string }>> {
  const or: string[] = [];
  if (admin.linked_member_id) or.push(`id.eq.${admin.linked_member_id}`);
  if (admin.phone_e164) or.push(`phone_e164.eq.${admin.phone_e164}`);
  if (!or.length) return [];
  const { data } = await sb.from('household_members').select('id, household_id')
    .eq('tenant_id', tenantId).eq('active', true).or(or.join(',')).limit(5);
  return (data ?? []).map(m => ({ id: m.id as string, household_id: m.household_id as string }));
}

async function setLink(sb: Db, tenantId: string, adminId: string, memberId: string): Promise<void> {
  await sb.from('admin_users').update({ linked_member_id: memberId })
    .eq('id', adminId).eq('tenant_id', tenantId).is('linked_member_id', null);
  try {
    await sb.from('audit_log').insert({
      tenant_id: tenantId, kind: 'admin.linked_to_member', entity_type: 'admin_user', entity_id: adminId,
      summary: 'Board login linked to their own family membership, by mobile number', actor_kind: 'system',
    });
  } catch { /* the link stands either way */ }
}

/**
 * Link a board login to the one active family member at the club with its
 * mobile number (PLAN.md CN1, CN2). Returns who they are, or null.
 */
export async function linkAdminByPhone(sb: Db, tenantId: string,
  admin: { id: string; phone_e164?: string | null; linked_member_id?: string | null },
): Promise<null | { member_id: string; household_id: string; family_name: string }> {
  try {
    const famOf = async (memberId: string) => {
      const { data: m } = await sb.from('household_members').select('id, household_id')
        .eq('id', memberId).eq('tenant_id', tenantId).maybeSingle();
      if (!m) return null;
      const { data: h } = await sb.from('households').select('family_name').eq('id', m.household_id).maybeSingle();
      return { member_id: String(m.id), household_id: String(m.household_id), family_name: String(h?.family_name ?? '') };
    };
    if (admin.linked_member_id) return await famOf(admin.linked_member_id);
    if (!admin.phone_e164) return null;
    const { data: hits } = await sb.from('household_members').select('id, household_id')
      .eq('tenant_id', tenantId).eq('active', true).eq('phone_e164', admin.phone_e164).limit(2);
    if (!hits || hits.length !== 1) return null;   // nobody, or not sure who
    await setLink(sb, tenantId, admin.id, String(hits[0].id));
    admin.linked_member_id = String(hits[0].id);
    return await famOf(String(hits[0].id));
  } catch { return null; }   // never block an invite or a sign-in over it
}

/**
 * A family just approved: each adult with a mobile number that's an active
 * board login's is linked to it, the board member themselves, not the
 * person who opened the membership (PLAN.md CN3). Returns how many.
 */
export async function linkHousehold(sb: Db, tenantId: string, householdId: string): Promise<number> {
  let n = 0;
  try {
    const { data: people } = await sb.from('household_members').select('id, phone_e164')
      .eq('household_id', householdId).eq('tenant_id', tenantId).eq('active', true);
    for (const p of (people ?? []) as Array<{ id: string; phone_e164: string | null }>) {
      if (!p.phone_e164) continue;
      const { data: admins } = await sb.from('admin_users').select('id')
        .eq('tenant_id', tenantId).eq('active', true).eq('phone_e164', p.phone_e164).is('linked_member_id', null);
      for (const a of (admins ?? []) as Array<{ id: string }>) { await setLink(sb, tenantId, a.id, p.id); n++; }
    }
  } catch { /* never fail an approval over it */ }
  return n;
}

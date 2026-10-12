// =============================================================================
// board_member.ts — a board login and a family member who are the same person
// =============================================================================
// Matched three ways, like member_auth's `is_board_member` ("Board tools" on
// the member side): the admin login's linked_member_id, the same phone, or
// the same email. linked_member_id is only set when a signup happens to
// match an existing admin, so someone made an admin after joining has no
// link. Used so one switch on one phone turns on both board and member
// pop-ups (PLAN.md AH2).
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Active board logins that are this family member. */
export async function adminsForMember(sb: SupabaseClient, tenantId: string,
  member: { id: string; phone_e164?: string | null; email?: string | null }): Promise<string[]> {
  const or = [`linked_member_id.eq.${member.id}`];
  if (member.phone_e164) or.push(`phone_e164.eq.${member.phone_e164}`);
  if (member.email) or.push(`email.eq.${String(member.email).toLowerCase()}`);
  const { data } = await sb.from('admin_users').select('id')
    .eq('tenant_id', tenantId).eq('active', true).or(or.join(',')).limit(5);
  return (data ?? []).map(a => a.id as string);
}

/** Active family members who are this board login. */
export async function membersForAdmin(sb: SupabaseClient, tenantId: string,
  admin: { linked_member_id?: string | null; phone_e164?: string | null; email?: string | null }): Promise<Array<{ id: string; household_id: string }>> {
  const or: string[] = [];
  if (admin.linked_member_id) or.push(`id.eq.${admin.linked_member_id}`);
  if (admin.phone_e164) or.push(`phone_e164.eq.${admin.phone_e164}`);
  if (admin.email) or.push(`email.eq.${String(admin.email).toLowerCase()}`);
  if (!or.length) return [];
  const { data } = await sb.from('household_members').select('id, household_id')
    .eq('tenant_id', tenantId).eq('active', true).or(or.join(',')).limit(5);
  return (data ?? []).map(m => ({ id: m.id as string, household_id: m.household_id as string }));
}

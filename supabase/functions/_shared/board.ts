// =============================================================================
// board — who counts as a board member, and who can change meeting minutes
// =============================================================================
// Every active admin login is a board member except lifeguard / gate-iPad
// logins (role 'gate_attendant'), which exist only for the check-in page.
// Any board member can start a meeting and read all minutes, including
// board-only ones. Only the note-taker (whoever started it) and the
// president (an owner login) can change a meeting. Once it's closed, only
// the president can delete it.
// Tested offline by scripts/test_board_meetings.mjs.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type Login = {
  id?: string; role_template?: string | null; roles?: string[] | null;
  active?: boolean | null; display_name?: string | null; email?: string | null;
};
export type BoardCaller = { id: string; isOwner: boolean; name: string };

const GATE_ONLY = 'gate_attendant';

export function isBoardMember(a: Login): boolean {
  if (a.active === false) return false;
  if (a.role_template === GATE_ONLY) return false;
  const roles = a.roles ?? [];
  return !(roles.length > 0 && roles.every(r => r === GATE_ONLY));
}

export function canEditMeeting(meeting: { created_by?: string | null }, caller: { id: string; isOwner: boolean }): boolean {
  return caller.isOwner || (!!meeting.created_by && meeting.created_by === caller.id);
}

export function canDeleteMeeting(meeting: { created_by?: string | null; status?: string | null }, caller: { id: string; isOwner: boolean }): boolean {
  if (meeting.status === 'completed') return caller.isOwner;
  return canEditMeeting(meeting, caller);
}

/** The signed-in board member, or null for anyone who isn't one. */
export async function boardCaller(sb: SupabaseClient, adminId: string, tenantId: string): Promise<BoardCaller | null> {
  const { data: a } = await sb.from('admin_users')
    .select('id, role_template, roles, active, display_name, email')
    .eq('id', adminId).eq('tenant_id', tenantId).maybeSingle();
  if (!a || !isBoardMember(a)) return null;
  return {
    id: a.id,
    isOwner: (a.role_template ?? 'owner') === 'owner',
    name: a.display_name || a.email || 'Board member',
  };
}

// =============================================================================
// positions_db — the database side of board positions (PLAN.md K)
// =============================================================================
// The rules are in positions.ts. This loads a club's positions and holders,
// keeps each board login's title and access in step with the positions it
// holds, and answers "who gets this alert".
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loginFromPositions, noticeRecipients, type Holder, type Login, type Position } from './positions.ts';

// deno-lint-ignore no-explicit-any
type SB = SupabaseClient<any, any, any>;

export const POSITION_FIELDS = 'id, slug, title, purpose, description, notices, scopes, full_access, sort';

export type BoardData = {
  positions: (Position & { purpose?: string | null; description?: string | null })[];
  holders: Holder[];
  logins: (Login & { display_name?: string | null; board_title?: string | null })[];
};

/** A club's positions (in order), who holds them, and its board logins
 *  (not gate iPad logins). */
export async function loadBoard(sb: SB, tenantId: string): Promise<BoardData> {
  const [{ data: positions }, { data: holders }, { data: logins }] = await Promise.all([
    sb.from('board_positions').select(POSITION_FIELDS).eq('tenant_id', tenantId).order('sort').order('title'),
    sb.from('board_position_holders').select('position_id, admin_user_id').eq('tenant_id', tenantId).order('assigned_at'),
    sb.from('admin_users').select('id, display_name, email, board_title, role_template, roles, scopes, is_super, active, last_login_at, phone_e164, linked_member_id, member_discount_pct')
      .eq('tenant_id', tenantId),
  ]);
  const board = (logins ?? []).filter(l => l.role_template !== 'gate_attendant'
    && !((l.roles ?? []).length && (l.roles ?? []).every((r: string) => r === 'gate_attendant')));
  return { positions: (positions ?? []) as BoardData['positions'], holders: (holders ?? []) as Holder[], logins: board as BoardData['logins'] };
}

/** The active board members an alert goes to right now. */
export async function recipientsFor(sb: SB, tenantId: string, notice: string): Promise<string[]> {
  const b = await loadBoard(sb, tenantId);
  return noticeRecipients(notice, b.positions, b.holders, b.logins);
}

/**
 * Set each person's title and access from the positions they hold. Pass only
 * the people whose positions just changed: a board member who was never given
 * a position keeps what they had, and one who no longer holds any loses their
 * title and extra screens but stays on the board.
 */
export async function syncLogins(sb: SB, tenantId: string, adminIds: string[], b?: BoardData, opts: { by?: string | null } = {}): Promise<{ waiting: string[] }> {
  const board = b ?? await loadBoard(sb, tenantId);
  const waiting: string[] = [];
  for (const id of [...new Set(adminIds)]) {
    const held = board.positions.filter(p => board.holders.some(h => h.position_id === p.id && h.admin_user_id === id));
    if (!held.length) {
      await sb.from('admin_users').update({ board_title: null, role_template: 'custom', roles: ['custom'], scopes: [] })
        .eq('id', id).eq('tenant_id', tenantId);
      continue;
    }
    const login = loginFromPositions(held);
    // Full access for someone who didn't have it waits for a second board
    // member (PLAN.md CQ3): meanwhile they get their other positions' screens.
    if (login.role_template === 'owner' && !hasFullAccess(board.logins.find(l => l.id === id))) {
      const rest = loginFromPositions(held.filter(p => !p.full_access));
      await sb.from('admin_users').update({ board_title: login.board_title, role_template: 'custom', roles: ['custom'], scopes: rest.scopes })
        .eq('id', id).eq('tenant_id', tenantId);
      const who = board.logins.find(l => l.id === id);
      const { requestChange } = await import('./pending_change.ts');
      const req = await requestChange(sb as never, {
        tenantId, kind: 'full_access', targetAdminId: id, requestedBy: opts.by ?? null,
        summary: `give ${who?.display_name || 'a board member'} full access${login.board_title ? ` (${login.board_title})` : ''}`,
      });
      // Nobody else on the board: the asker's code was enough, it's done.
      if (!req.applied) waiting.push(id);
      continue;
    }
    await sb.from('admin_users').update(login).eq('id', id).eq('tenant_id', tenantId);
  }
  return { waiting };
}

/** Full access now: the club's owner role, or Poolside's founder flag. */
export function hasFullAccess(l: unknown): boolean {
  const a = (l ?? {}) as { is_super?: boolean; role_template?: string; roles?: string[] | null };
  return a.is_super === true || a.role_template === 'owner' || (a.roles ?? []).includes('owner');
}

/** Whether giving these people these positions would hand anyone full access they don't have. */
export function grantsFullAccess(b: BoardData, adminIds: string[]): boolean {
  return [...new Set(adminIds)].some(id => {
    const held = b.positions.filter(p => b.holders.some(h => h.position_id === p.id && h.admin_user_id === id));
    return held.some(p => p.full_access) && !hasFullAccess(b.logins.find(l => l.id === id));
  });
}

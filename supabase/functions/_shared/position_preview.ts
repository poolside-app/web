// =============================================================================
// position_preview.ts — the board as if someone held one position (PLAN.md CC5)
// =============================================================================
// A position's look-only preview has nobody in it, so its home, to-dos and
// Member help are worked out for a pretend holder with the empty id: the
// position's own screens and alerts (loginFromPositions, as for anyone who
// holds it), plus what's assigned to whoever holds it now (`sees`).
// =============================================================================
import { loginFromPositions, type Holder, type Login } from './positions.ts';
import type { BoardData } from './positions_db.ts';
import { NIL } from './board_view.ts';

export function positionPreview(b: BoardData, posId: string) {
  const position = b.positions.find(p => p.id === posId);
  if (!position) return null;
  const login = loginFromPositions([position]);
  const sees = b.holders.filter(h => h.position_id === posId).map(h => h.admin_user_id)
    .filter(id => b.logins.some(l => l.id === id && l.active !== false));
  const board: BoardData = {
    positions: b.positions,
    holders: [...b.holders, { position_id: posId, admin_user_id: NIL } as Holder],
    logins: [...b.logins, {
      id: NIL, active: true, role_template: login.role_template, roles: login.roles, scopes: login.scopes,
      display_name: position.title, board_title: position.title,
    } as Login & { display_name: string; board_title: string }],
  };
  const isOwner = login.role_template === 'owner' || login.roles.includes('owner');
  return { position, login, board, sees, caller: { id: NIL, isOwner, scopes: login.scopes } };
}

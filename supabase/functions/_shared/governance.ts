// =============================================================================
// governance.ts — who may read a club's bylaws, minutes and board (PLAN.md BJ1)
// =============================================================================
// Doug, 10/21: the bylaws, the board minutes and the board's names are for the
// club's members only. A member of the club or a board member may read them,
// with the sign-in already on their phone; nobody signed in gets anything. The
// club is the one in the sign-in, never one named in the request.
//
// This only reads the sign-in's claims; board_meetings `governance` then checks
// the database (an active household member of that club, or a board member),
// so a removed member or board member is refused on their next visit.
// =============================================================================

export type GovReader = { kind: 'member' | 'board'; id: string; tid: string; synthetic?: boolean };

export function readerFromClaims(p: Record<string, unknown> | null | undefined): GovReader | null {
  if (!p || !p.sub || !p.tid) return null;
  if (p.kind === 'member') return { kind: 'member', id: String(p.sub), tid: String(p.tid) };
  if (p.kind === 'tenant_admin') return { kind: 'board', id: String(p.sub), tid: String(p.tid), synthetic: p.synthetic === true };
  return null;
}

// =============================================================================
// board_view.ts — the President's look-only preview of a board member's board
// =============================================================================
// PLAN.md CC (Doug 11/6): "is there a way i can see each board members board
// page as i have selected their options..? just a view somehow?"
//
// tenant_admin_auth `view_as` gives the President a one-hour sign-in of its
// own kind, `board_view`, for one board member. Every function refuses any
// sign-in whose kind isn't `tenant_admin`, so a preview can do nothing by
// default. The only functions that take one are those the board home reads
// from, and only for those reads (VIEW_READS); they refuse anything else
// with 403 before doing any work. No remote imports, so the offline tests
// load this file as it is (scripts/test_board_view.mjs).
// =============================================================================

export const VIEW_KIND = 'board_view';
export const VIEW_SECONDS = 60 * 60;
export const LOOK_ONLY = 'This is a look-only preview. Nothing can be changed from it.';

// What the board home reads: who's signed in, their tasks and home, and the
// setup checklist. Nothing here writes.
export const VIEW_READS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tenant_admin_auth: Object.freeze(['me']),
  admin_tasks: Object.freeze(['home', 'list', 'count']),
  tenant_settings: Object.freeze(['setup_status']),
});

export function viewAllowed(fn: string, action: string): boolean {
  if (!Object.prototype.hasOwnProperty.call(VIEW_READS, fn)) return false;
  return VIEW_READS[fn].includes(action);
}

export type ViewClaims = {
  kind: 'board_view'; sub: string; tid: string; slug: string;
  by: string; by_name: string; exp: number;
};

/** The sign-in's contents: who it's for (sub) and who's looking (by). Their
 *  screens are never in it; every read looks them up, so it shows today's ticks. */
export function viewClaims(o: { target: string; tid: string; slug: string; by: string; byName: string; nowSec: number }): ViewClaims {
  return { kind: VIEW_KIND, sub: o.target, tid: o.tid, slug: o.slug, by: o.by, by_name: o.byName, exp: o.nowSec + VIEW_SECONDS };
}

/** A verified token's claims, if they're a preview's. */
export function asView(p: Record<string, unknown> | null | undefined): ViewClaims | null {
  if (!p || p.kind !== VIEW_KIND) return null;
  if (!p.sub || !p.tid || !p.by || p.sub === p.by) return null;
  return p as unknown as ViewClaims;
}

/** Why the caller can't see this person's view, or null if they can. */
export function canPreview(
  caller: { id: string; tid: string; isOwner: boolean },
  target: { id: string; tenant_id: string; active: boolean | null; role_template: string | null } | null,
): string | null {
  if (!caller.isOwner) return 'Only the President can see a board member\'s view.';
  if (!target || target.tenant_id !== caller.tid) return 'Board member not found.';
  if (target.id === caller.id) return 'That\'s you.';
  if (target.active === false) return 'They\'re not on the board any more.';
  if (target.role_template === 'gate_attendant') return 'Only board members have a board view.';
  return null;
}

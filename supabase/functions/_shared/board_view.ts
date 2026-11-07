// =============================================================================
// board_view.ts — the President's look-only preview of a board member's or a
// position's board
// =============================================================================
// PLAN.md CC (Doug 11/6): "is there a way i can see each board members board
// page as i have selected their options..? just a view somehow?", then "i
// dont want to need to invite someone.. just see and interacti with thier
// interface".
//
// tenant_admin_auth `view_as` gives the President a one-hour sign-in of its
// own kind, `board_view`, for one board member (`sub`) or one position (`pos`,
// with nobody in it). Every function refuses any sign-in whose kind isn't
// `tenant_admin`, so a preview can do nothing by default. Two ways in:
//   - VIEW_READS: the reads worked out as them (who's signed in, their home
//     and to-dos, the setup list, Member help). Those functions take the
//     preview for these actions only and refuse anything else with 403.
//   - PREVIEW_READS: every other screen's reads, through the `board_preview`
//     relay, which asks the screen's own function as the President for a
//     minute and answers as the preview. Each is a read that writes nothing
//     (scripts/test_board_view.mjs checks every one), except TIDY_READS,
//     which tidy up as they read, the same for anyone who opens the screen.
// No remote imports, so the offline tests load this file as it is.
// =============================================================================

export const VIEW_KIND = 'board_view';
export const VIEW_SECONDS = 60 * 60;
export const LOOK_ONLY = 'This is a look-only preview. Nothing can be changed from it.';
/** The empty id: who a position's preview is (nobody in particular). */
export const NIL = '00000000-0000-0000-0000-000000000000';

const freeze = (o: Record<string, string[]>) => Object.freeze(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Object.freeze(v)])));

// Worked out as them. Nothing here writes.
export const VIEW_READS: Readonly<Record<string, readonly string[]>> = freeze({
  tenant_admin_auth: ['me'],
  admin_tasks: ['home', 'list', 'count'],
  tenant_settings: ['setup_status'],
  help_requests: ['list', 'get', 'topics'],
});

// Every other board screen's reads (PLAN.md CC6), through the relay.
export const PREVIEW_READS: Readonly<Record<string, readonly string[]>> = freeze({
  admin_tasks: ['time_saved'],
  applications: ['list', 'list_years', 'log', 'list_prefilled'],
  audit_admin: ['list'],
  board: ['get'],
  board_meetings: ['list', 'get', 'next', 'agenda', 'bylaws', 'list_active_admins'],
  donations: ['list'],
  email_templates: ['list', 'outbox'],
  events_admin: ['list'],
  external_calendar: ['list_feeds', 'list_public'],
  gate_admin: ['get_status', 'recent_unlocks', 'pass_list', 'pass_families'],
  google_drive_sync: ['status'],
  households_admin: ['list'],
  keyfobs: ['list', 'settings_get', 'sync_status'],
  lifeguards: ['list_shifts', 'list_roster'],
  parties_admin: ['list', 'settings_get'],
  payment_plans: ['config_get', 'upcoming', 'list_plans'],
  payments_admin: ['list', 'refund_reviews', 'venmo_waiting', 'codes_list'],
  photos_admin: ['list', 'list_pending', 'pending_count'],
  policies: ['list'],
  posts_admin: ['list'],
  programs: ['list', 'roster'],
  referrals: ['list'],
  renewals: ['renewal_audience', 'list_history', 'sms_usage'],
  sms_blasts: ['list', 'history'],
  sponsors_admin: ['list'],
  stripe_connect: ['status'],
  tenant_settings: ['get', 'season_status'],
  volunteer: ['list', 'roster'],
});

// Reads that tidy up as they read, for anyone who opens the screen: texts
// past their send-by marked expired, a keyfob check the gate computer never
// finished marked failed, a season never pinned pinned to the one shown.
export const TIDY_READS: readonly string[] = Object.freeze(['sms_blasts:list', 'keyfobs:sync_status', 'tenant_settings:season_status']);

const has = (m: Readonly<Record<string, readonly string[]>>, fn: string, action: string) =>
  Object.prototype.hasOwnProperty.call(m, fn) && m[fn].includes(action);

export function viewAllowed(fn: string, action: string): boolean { return has(VIEW_READS, fn, action); }
export function previewReadAllowed(fn: string, action: string): boolean { return has(PREVIEW_READS, fn, action); }

export type ViewClaims = {
  kind: 'board_view'; sub: string; tid: string; slug: string;
  by: string; by_name: string; exp: number; pos?: string;
};

/** The sign-in's contents: who it's for (`sub`, or a position `pos` with
 *  nobody in it) and who's looking (`by`). Their screens are never in it;
 *  every read looks them up, so it shows today's ticks. */
export function viewClaims(o: { target?: string; position?: string; tid: string; slug: string; by: string; byName: string; nowSec: number }): ViewClaims {
  const c: ViewClaims = { kind: VIEW_KIND, sub: o.position ? NIL : String(o.target ?? ''), tid: o.tid, slug: o.slug, by: o.by, by_name: o.byName, exp: o.nowSec + VIEW_SECONDS };
  if (o.position) c.pos = o.position;
  return c;
}

/** A verified token's claims, if they're a preview's. */
export function asView(p: Record<string, unknown> | null | undefined): ViewClaims | null {
  if (!p || p.kind !== VIEW_KIND) return null;
  if (!p.sub || !p.tid || !p.by || p.sub === p.by) return null;
  if (p.pos ? p.sub !== NIL : p.sub === NIL) return null;   // a position has nobody in it; a person has no position
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

/** Why the caller can't see this position's view, or null if they can. */
export function canPreviewPosition(caller: { tid: string; isOwner: boolean }, position: { tenant_id: string } | null): string | null {
  if (!caller.isOwner) return 'Only the President can see a position\'s view.';
  if (!position || position.tenant_id !== caller.tid) return 'Position not found.';
  return null;
}

/** `me`'s user for a position's preview: the position, its screens (as
 *  loginFromPositions gives anyone who holds it, when passed), not the President. */
export function positionUser(
  position: { title: string; scopes?: string[] | null },
  byName: string | null,
  login?: { role_template: string; roles: string[]; scopes: string[] },
) {
  return {
    id: NIL, email: null, display_name: position.title, board_title: position.title,
    is_super: false, is_default_pw: false, active: true,
    role_template: login?.role_template ?? 'custom', roles: login?.roles ?? ['custom'], scopes: [...(login?.scopes ?? position.scopes ?? [])],
    linked_member_id: null, member_apply_dismissed: true, phone_e164: null, impersonated: false,
    viewing: { by_name: byName ?? null, position: true },
  };
}

/** A relayed answer, as the preview: whether they're the President, and who "me" is. */
export function previewPatch<T>(answer: T, as: { me: string; isOwner: boolean }): T {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return answer;
  const out = { ...(answer as Record<string, unknown>) };
  if ('is_owner' in out) out.is_owner = as.isOwner;
  if ('me' in out && typeof out.me === 'string') out.me = as.me;
  return out as T;
}

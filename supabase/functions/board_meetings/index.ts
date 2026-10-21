// =============================================================================
// board_meetings — Secretary's note-taking surface for board meetings
// =============================================================================
// Auth: tenant_admin token of a board member (_shared/board.ts). Any board
// member can start a meeting and read all minutes; only the note-taker
// (created_by) and the president can change one. Lifeguard / gate-iPad
// logins are refused. The club's members read the bylaws and closed minutes
// with their own sign-in (governance, below); nobody signed out reads anything.
//
// Admin actions:
//   { action: 'list' }
//     → { ok, meetings: [...] }     // newest-first, all statuses. Every
//                                    // meeting carries note_taker + can_edit.
//
//   { action: 'get', id }
//     → { ok, meeting }
//
//   { action: 'create', title?, meeting_date?, location?, start? }
//     → { ok, meeting }              // status='draft' until 'start' is called;
//                                    // start:true starts the clock at once
//
//   { action: 'start', id }
//     → { ok, meeting }              // status='in_progress', started_at=now
//
//   { action: 'update', id, ...partial fields }
//     → { ok, meeting }              // autosave while the meeting is open;
//                                    // refused once it's closed (use amend)
//
//   { action: 'amend', id, ...partial fields }
//     → { ok, meeting }              // fix a closed meeting: stays closed and
//                                    // on the members' page, keeps its times,
//                                    // sets edited_at/edited_by, and puts the
//                                    // old version in audit_log
//
//   { action: 'finalize', id }
//     → { ok, meeting }              // "Close meeting": status='completed',
//                                    // ended_at=now. A Members meeting (the
//                                    // default) is on the members' page
//                                    // (governance) from here.
//                                    // Closing twice keeps the first time.
//
//   { action: 'delete', id }
//     → { ok }                       // hard-delete. Once closed, president
//                                    // only, and a copy goes to audit_log.
//
// Minutes approval (PLAN.md BJ3, Doug 10/21; rules in _shared/minutes_approval.ts).
// Closing a meeting leaves its minutes a draft; members see them only once the
// board members who attended have approved them:
//   { action: 'submit_minutes', id }      note-taker or president, after Close
//                                          meeting: asks each board member who
//                                          attended (a pop-up and a to-do); the
//                                          submitter counts as approving
//   { action: 'approve_minutes', id }     one of those asked
//   { action: 'request_changes', id, note }  one of those asked: back to draft,
//                                          the note-taker is told
//   { action: 'approve_for', id, admin_id }  the president, after 7 days
//   { action: 'edit_again', id }          note-taker or president: back to
//                                          draft (approvals start over)
// Approved minutes are locked; amend on them starts an amendment (a draft
// again; members keep seeing the approved copy, posted_json).
//
// There is no 'reopen': it cleared the real end time and pulled the
// minutes off the members' page while they were edited. amend replaced it.
//
//   { action: 'list_active_admins' }
//     → { ok, admins: [{id, name, role_label}] }
//                                    // Board members, for the attendance
//                                    // checkboxes (no lifeguard logins)
//
// Agenda (PLAN.md L, Doug 2026-10-06). Any board member; board only:
//   { action: 'next' }                   → the next planned meeting and the
//                                           one-liners waiting for it
//   { action: 'add_item', body }         → one line, 100 characters at most
//   { action: 'update_item', id, body }  → your own (the president: anyone's)
//   { action: 'delete_item', id }        → your own (the president: anyone's)
//   { action: 'create_agenda', meeting_id? | meeting_date + planned_time? + location? }
//                                         → the next planned meeting (or a new
//                                           one) gets the waiting items
//   { action: 'agenda', meeting_id }     → the agenda, laid out by person
//   { action: 'cover_item', id, covered }  → checked off at the meeting
//                                           (note-taker or president). When
//                                           the meeting closes, unchecked
//                                           items go back on the list.
//   { action: 'send_agenda', meeting_id, preview? }   a pop-up to each board member (in the app only)
//                                         → texts or emails it to every board
//                                           member (their preference) and pops
//                                           up; preview: true says who'd get
//                                           it how, and sends nothing
//
// For the club's members (PLAN.md BJ1, Doug 10/21), used by /governance.html:
//   { action: 'governance' }  with a member's or a board member's sign-in
//     → { ok, meetings, bylaws, board }   // closed minutes the members may
//                                          // see, the bylaws (links that work
//                                          // for an hour), who's on the board.
//                                          // Signed out → 401 and nothing else.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { boardCaller, canDeleteMeeting, canEditMeeting, isBoardMember, type BoardCaller } from '../_shared/board.ts';
import { poolToday, tenantTimeZone } from '../_shared/pool_time.ts';
import { clearFollowUpTasks, syncFollowUpTasks, type MeetingForTasks } from '../_shared/meeting_follow_ups.ts';
import { cleanItem, itemProblem, buildAgenda, agendaText, longDate, clock, type AgendaItem, type FollowUp } from '../_shared/agenda.ts';
import { loadBoard } from '../_shared/positions_db.ts';
import { boardRoster } from '../_shared/positions.ts';
import { readerFromClaims } from '../_shared/governance.ts';
import { moveToPrivate, withLinks, type DocRow } from '../_shared/club_docs.ts';
import { approversFor, progress, mayApproveFor, editMode, snapshot, ON_BEHALF_DAYS, type Attendee } from '../_shared/minutes_approval.ts';
import { enqueueAdminTask, pushBoard } from '../_shared/enqueue_task.ts';

// The bylaws (PLAN.md K6): every upload is kept; the newest is current. The
// files are private (BJ1): readers get links that work for an hour.
const DOC_FIELDS = 'id, url, storage_path, file_name, uploaded_by_name, uploaded_at';
async function bylawsFor(sb: ReturnType<typeof createClient>, tenantId: string) {
  const { data } = await sb.from('club_documents').select(DOC_FIELDS)
    .eq('tenant_id', tenantId).eq('kind', 'bylaws').order('uploaded_at', { ascending: false }).limit(20);
  const rows = await withLinks(sb, SUPABASE_URL, tenantId, (data ?? []) as DocRow[]);
  return { current: rows[0] ?? null, earlier: rows.slice(1) };
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

type Payload = { sub: string; kind: string; tid: string; synthetic?: boolean };
// Any Poolside sign-in's claims, if it's genuine (governance reads members' too).
async function verifyClaims(token: string): Promise<Record<string, unknown> | null> {
  if (!JWT_SECRET || !token) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    return await verify(token, key) as Record<string, unknown>;
  } catch { return null; }
}
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const FIELDS = 'id, tenant_id, title, meeting_date, location, status, started_at, ended_at, visibility, notes_md, attendees_json, votes_json, follow_ups_json, created_by, created_at, updated_at, edited_at, edited_by, planned_time, agenda_created_at, agenda_created_by, agenda_sent_at, agenda_sent_by, minutes_status, approval_round, submitted_at, submitted_by, changes_note, changes_by_name, changes_at, posted_at, posted_count, approved_at';
// What a correction can change, and what the audit log keeps of the old one.
const CONTENT = ['title', 'meeting_date', 'location', 'notes_md', 'attendees_json', 'votes_json', 'follow_ups_json', 'visibility'] as const;

// Members (the default, on the members' page) or Board only (PLAN.md BJ2: no public option).
const VALID_VIS = new Set(['private', 'members']);

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Sanitize an attendees array. Drops anything that doesn't have a name; caps
// length so a malicious admin can't blow up the row.
function sanitizeAttendees(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 200).map(raw => {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const name = String(r.name ?? '').trim().slice(0, 120);
    if (!name) return null;
    return {
      admin_user_id: r.admin_user_id ? String(r.admin_user_id) : null,
      name,
      role: String(r.role ?? '').trim().slice(0, 60) || null,
      source: r.source === 'admin' ? 'admin' : 'manual',
    };
  }).filter((x): x is Record<string, unknown> => !!x);
}

/** keepEmpty: while the meeting is open, a motion just added (nothing typed
 *  or counted yet) stays. Dropping it made the page's vote buttons point at
 *  a motion the server had thrown away, so they did nothing (Doug, 10/8). */
function sanitizeVotes(input: unknown, keepEmpty = false): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const VALID_OUT = new Set(['passed', 'failed', 'tabled', 'pending']);
  return input.slice(0, 100).map(raw => {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const motion = String(r.motion ?? '').trim().slice(0, 1000);
    const yes     = Math.max(0, Math.trunc(Number(r.yes ?? 0)) || 0);
    const no      = Math.max(0, Math.trunc(Number(r.no ?? 0)) || 0);
    const abstain = Math.max(0, Math.trunc(Number(r.abstain ?? 0)) || 0);
    const outcome = String(r.outcome ?? 'pending');
    const notes   = String(r.notes ?? '').trim().slice(0, 2000);
    const proposed_by = String(r.proposed_by ?? '').trim().slice(0, 120);
    const seconded_by = String(r.seconded_by ?? '').trim().slice(0, 120);
    // Keep the row if it has ANY data — empty motions are allowed
    // mid-meeting so the secretary can record vote counts before typing
    // the motion text. Only skip rows that are completely empty (the
    // user clicked + Add motion and then changed their mind).
    const hasAnyData = !!motion || yes > 0 || no > 0 || abstain > 0
      || (outcome !== 'pending' && outcome !== '') || !!notes || !!proposed_by || !!seconded_by;
    if (!hasAnyData && !keepEmpty) return null;
    return {
      id: r.id ? String(r.id).slice(0, 40) : crypto.randomUUID(),
      motion,
      proposed_by: proposed_by || null,
      seconded_by: seconded_by || null,
      yes, no, abstain,
      outcome: VALID_OUT.has(outcome) ? outcome : 'pending',
      notes: notes || null,
    };
  }).filter((x): x is Record<string, unknown> => !!x);
}

function sanitizeFollowUps(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const VALID_S = new Set(['open', 'done', 'cancelled']);
  return input.slice(0, 100).map(raw => {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const description = String(r.description ?? '').trim().slice(0, 500);
    const assigned_to = String(r.assigned_to ?? '').trim().slice(0, 120);
    const status = String(r.status ?? 'open');
    let due_date: string | null = null;
    if (r.due_date) {
      const s = String(r.due_date).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) due_date = s;
    }
    // Keep rows with any data so an in-flight follow-up doesn't disappear
    // on autosave just because description hasn't been typed yet.
    const hasAnyData = !!description || !!assigned_to || !!due_date || (status && status !== 'open');
    if (!hasAnyData) return null;
    // Set when the name was picked from the board list: the follow-up then
    // goes on that board member's dashboard when the meeting closes.
    const aid = String(r.assigned_admin_id ?? '');
    return {
      id: r.id ? String(r.id).slice(0, 40) : crypto.randomUUID(),
      description,
      assigned_to: assigned_to || null,
      assigned_admin_id: assigned_to && /^[0-9a-f-]{36}$/i.test(aid) ? aid : null,
      due_date,
      status: VALID_S.has(status) ? status : 'open',
    };
  }).filter((x): x is Record<string, unknown> => !!x);
}

// The fields a note-taker types, from an update or amend body. Anything not
// sent is left alone.
function contentPatch(body: Record<string, unknown>, opts: { open?: boolean } = {}): { patch: Record<string, unknown>; bad?: Response } {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.title !== undefined) {
    const v = String(body.title).trim();
    patch.title = v || 'Board Meeting';
  }
  if (body.meeting_date !== undefined) {
    const s = String(body.meeting_date).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) patch.meeting_date = s;
  }
  if (body.location !== undefined)   patch.location = strOrNull(body.location);
  if (body.planned_time !== undefined) {
    const t = String(body.planned_time ?? '').trim();
    patch.planned_time = /^[0-2]\d:[0-5]\d$/.test(t) ? t : null;
  }
  if (body.notes_md !== undefined)   patch.notes_md = String(body.notes_md ?? '').slice(0, 50000);
  if (body.attendees !== undefined)  patch.attendees_json  = sanitizeAttendees(body.attendees);
  if (body.votes !== undefined)      patch.votes_json      = sanitizeVotes(body.votes, !!opts.open);
  if (body.follow_ups !== undefined) patch.follow_ups_json = sanitizeFollowUps(body.follow_ups);
  if (body.visibility !== undefined) {
    // A page from before BJ2 still sends 'public': that's 'members' now.
    const v = String(body.visibility) === 'public' ? 'members' : String(body.visibility);
    if (!VALID_VIS.has(v)) return { patch, bad: jsonResponse({ ok: false, error: 'invalid visibility' }, 400) };
    patch.visibility = v;
  }
  return { patch };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── governance — the club's members (PLAN.md BJ1, Doug 10/21) ──────────
  // /governance.html: the bylaws, the closed minutes members may see, and
  // who's on the board. Only with the sign-in of an active member of the club
  // or a board member; nobody else gets anything, not even the club's name.
  // The club is the one in the sign-in.
  if (action === 'governance') {
    const hdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const reader = readerFromClaims(hdr.startsWith('Bearer ') ? await verifyClaims(hdr.slice(7)) : null);
    const refuse = () => jsonResponse({ ok: false, signin: true, error: 'Sign in to see the bylaws and minutes.' }, 401);
    if (!reader) return refuse();
    if (reader.kind === 'member') {
      const { data: m } = await sb.from('household_members').select('id, active')
        .eq('id', reader.id).eq('tenant_id', reader.tid).maybeSingle();
      if (!m || m.active === false) return refuse();
    } else if (!reader.synthetic && !(await boardCaller(sb, reader.id, reader.tid))) {
      return refuse();
    }
    const tid = reader.tid;
    // The approved copy of each meeting's minutes (PLAN.md BJ3): a change
    // waiting for approval doesn't show until it's approved.
    const { data, error } = await sb.from('board_meetings').select('id, posted_json, posted_at, posted_count')
      .eq('tenant_id', tid)
      .not('posted_json', 'is', null)
      .eq('posted_json->>visibility', 'members')
      .order('meeting_date', { ascending: false })
      .limit(100);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const meetings = (data ?? []).map(m => ({
      ...(m.posted_json as Record<string, unknown>), id: m.id, approved_at: m.posted_at,
      amended_at: Number(m.posted_count ?? 0) > 1 ? m.posted_at : null,
    }));
    // Who's on the board: names and positions only. Job descriptions stay with the board.
    const b = await loadBoard(sb as never, tid);
    return jsonResponse({
      ok: true, meetings,
      bylaws: await bylawsFor(sb, tid),
      board: boardRoster(b.positions, b.holders, b.logins),
    });
  }

  // ── Admin-only actions below ───────────────────────────────────────────
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  const me: BoardCaller | null = payload.synthetic
    ? { id: payload.sub, isOwner: true, name: 'Poolside' }
    : await boardCaller(sb, payload.sub, payload.tid);
  if (!me) return jsonResponse({ ok: false, error: 'Board minutes are for board members only.' }, 403);
  const TID = payload.tid;

  // Adds who is taking the notes and whether the caller may change it.
  async function decorate(rows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const ids = [...new Set(rows.flatMap(r => [r.created_by, r.edited_by, r.agenda_sent_by]).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (ids.length) {
      const { data } = await sb.from('admin_users').select('id, display_name, email')
        .eq('tenant_id', TID).in('id', ids);
      for (const a of data ?? []) names.set(a.id, a.display_name || a.email);
    }
    // Minutes approval (BJ3): the current round's approvers.
    const asked = new Map<string, Array<Record<string, unknown>>>();
    const roundIds = rows.filter(r => Number(r.approval_round ?? 0) > 0).map(r => r.id as string);
    if (roundIds.length) {
      const { data: ap } = await sb.from('board_minutes_approvals')
        .select('meeting_id, round, admin_id, name, status, decided_at, decided_by_name, on_behalf')
        .in('meeting_id', roundIds).order('created_at');
      for (const a of ap ?? []) {
        const r = rows.find(x => x.id === a.meeting_id);
        if (!r || Number(a.round) !== Number(r.approval_round) || a.status === 'voided') continue;
        const list = asked.get(a.meeting_id as string) ?? []; list.push(a); asked.set(a.meeting_id as string, list);
      }
    }
    return rows.map(r => {
      const list = asked.get(r.id as string) ?? [];
      const pr = progress(list as Array<{ name: string; status: string }>);
      const submitted = r.minutes_status === 'submitted';
      const canEdit = canEditMeeting(r as { created_by?: string | null }, me!);
      return {
      ...r,
      approval: {
        round: r.approval_round ?? 0, rows: list, approved: pr.approved, total: pr.total, pending: pr.pending,
        can_submit: canEdit && r.status === 'completed' && r.minutes_status === 'draft',
        can_approve: submitted && list.some(a => a.admin_id === me!.id && a.status === 'pending'),
        can_approve_for: submitted && me!.isOwner && mayApproveFor(true, r.submitted_at as string | null)
          ? list.filter(a => a.status === 'pending' && a.admin_id !== me!.id).map(a => ({ admin_id: a.admin_id, name: a.name })) : [],
        can_edit_again: submitted && canEdit,
      },
      note_taker: r.created_by ? names.get(r.created_by as string) ?? null : null,
      edited_by_name: r.edited_by ? names.get(r.edited_by as string) ?? null : null,
      agenda_sent_by_name: r.agenda_sent_by ? names.get(r.agenda_sent_by as string) ?? null : null,
      can_edit: canEditMeeting(r as { created_by?: string | null }, me!),
      can_delete: canDeleteMeeting(r as { created_by?: string | null; status?: string }, me!),
    }; });
  }
  const one = async (row: Record<string, unknown>) => (await decorate([row]))[0];

  // Loads a meeting the caller may change, or the refusal to send instead.
  async function editable(id: string): Promise<{ row?: Record<string, unknown>; deny?: Response }> {
    if (!id) return { deny: jsonResponse({ ok: false, error: 'id required' }, 400) };
    const { data } = await sb.from('board_meetings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!data) return { deny: jsonResponse({ ok: false, error: 'Meeting not found' }, 404) };
    if (!canEditMeeting(data, me!)) {
      return { deny: jsonResponse({ ok: false, error: 'Only the note-taker and the president can change this meeting.' }, 403) };
    }
    return { row: data };
  }

  // Keeps the version being replaced or deleted, so closed minutes can
  // always be traced back.
  async function audit(kind: string, row: Record<string, unknown>, summary: string) {
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind, entity_type: 'board_meeting', entity_id: row.id,
        summary,
        actor_id: payload!.synthetic ? null : me!.id,
        actor_kind: 'tenant_admin',
        metadata: { before: Object.fromEntries(CONTENT.map(k => [k, row[k]])) },
      });
    } catch { /* never block the change on the audit write */ }
  }

  // ── Minutes approval helpers (PLAN.md BJ3) ─────────────────────────────
  const minutesLink = (id: string) => `/club/admin/board-meetings.html#m=${id}`;
  const meetingName = (m: Record<string, unknown>) => `the ${longDate(String(m.meeting_date), false)} board meeting`;
  async function closeMinutesTasks(id: string, kinds: string[], adminId?: string) {
    let q = sb.from('admin_tasks').update({ completed_at: new Date().toISOString() })
      .eq('tenant_id', TID).eq('source_kind', 'board_minutes').eq('source_id', id).in('kind', kinds).is('completed_at', null);
    if (adminId) q = q.eq('assigned_admin_id', adminId);
    await q;
  }
  async function voidRound(id: string, round: number) {
    await sb.from('board_minutes_approvals').update({ status: 'voided' })
      .eq('meeting_id', id).eq('round', round).eq('status', 'pending');
  }
  // The moment everyone asked has approved: keep the copy members see.
  async function postIfDone(m: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { data: rows } = await sb.from('board_minutes_approvals').select('name, status')
      .eq('meeting_id', m.id).eq('round', m.approval_round);
    if (!progress((rows ?? []) as Array<{ name: string; status: string }>).done) return m;
    const now = new Date().toISOString();
    const { data } = await sb.from('board_meetings').update({
      minutes_status: 'approved', approved_at: now, posted_json: snapshot(m), posted_at: now,
      posted_count: Number(m.posted_count ?? 0) + 1, updated_at: now,
    }).eq('id', m.id).eq('tenant_id', TID).eq('minutes_status', 'submitted').eq('approval_round', m.approval_round)
      .select(FIELDS).maybeSingle();
    if (!data) return m;   // another approval posted it a moment ago
    await closeMinutesTasks(m.id as string, ['minutes.approve']);
    const where = m.visibility === 'private' ? 'They\'re board only, so members won\'t see them.' : 'Members can read them now.';
    await audit('board_meeting.approved', m, `Minutes approved${Number(m.posted_count ?? 0) > 0 ? ' (an amendment)' : ''}: "${m.title}" (${m.meeting_date})`);
    if (m.created_by) {
      await pushBoard({ tenant_id: TID, target_scopes: [], admin_ids: [m.created_by as string],
        title: '✅ Minutes approved', body: `Everyone approved the minutes of ${meetingName(m)}. ${where}`,
        url: minutesLink(m.id as string), tag: `board_minutes:${m.id}` });
    }
    return data;
  }

  // ── Agenda items (PLAN.md L1) ──────────────────────────────────────────
  // One-liners for the next meeting. Waiting items have no meeting; once an
  // agenda is made for a meeting, new items join it until it starts.
  const ITEM_FIELDS = 'id, body, added_by, added_by_name, meeting_id, covered, carried_from, created_at';
  async function nextMeeting() {
    const today = poolToday(await tenantTimeZone(sb, TID));
    const { data } = await sb.from('board_meetings').select(FIELDS)
      .eq('tenant_id', TID).eq('status', 'draft').gte('meeting_date', today)
      .order('meeting_date').order('created_at').limit(1);
    return (data ?? [])[0] ?? null;
  }
  // Names, titles and "from Sep 12" for a list of items.
  async function shapeItems(rows: Record<string, unknown>[]) {
    const authorIds = [...new Set(rows.map(r => r.added_by).filter(Boolean))] as string[];
    const fromIds = [...new Set(rows.map(r => r.carried_from).filter(Boolean))] as string[];
    const [{ data: authors }, { data: froms }] = await Promise.all([
      authorIds.length ? sb.from('admin_users').select('id, display_name, board_title').in('id', authorIds) : Promise.resolve({ data: [] }),
      fromIds.length ? sb.from('board_meetings').select('id, meeting_date').in('id', fromIds) : Promise.resolve({ data: [] }),
    ]);
    const who = new Map((authors ?? []).map(a => [a.id, a]));
    const from = new Map((froms ?? []).map(m => [m.id, m.meeting_date]));
    return rows.map(r => {
      const a = r.added_by ? who.get(r.added_by as string) : null;
      return {
        id: r.id, body: r.body, created_at: r.created_at, covered: !!r.covered, meeting_id: r.meeting_id,
        added_by: r.added_by ?? null,
        added_by_name: (a?.display_name as string | undefined) || (r.added_by_name as string | null) || 'A board member',
        added_by_title: (a?.board_title as string | undefined) || null,
        carried_from_date: r.carried_from ? from.get(r.carried_from as string) ?? null : null,
        can_change: me!.isOwner || (!!r.added_by && r.added_by === me!.id),
      };
    });
  }
  async function changeableItem(id: string): Promise<{ row?: Record<string, unknown>; deny?: Response }> {
    const { data: row } = await sb.from('agenda_items').select(ITEM_FIELDS).eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!row) return { deny: jsonResponse({ ok: false, error: 'Item not found' }, 404) };
    if (!me!.isOwner && row.added_by !== me!.id) {
      return { deny: jsonResponse({ ok: false, error: 'Only the person who added it, or the president, can change it.' }, 403) };
    }
    if (row.meeting_id) {
      const { data: m } = await sb.from('board_meetings').select('status').eq('id', row.meeting_id).maybeSingle();
      if (m?.status === 'completed') return { deny: jsonResponse({ ok: false, error: 'That meeting is over.' }, 409) };
    }
    return { row };
  }

  if (action === 'next') {
    const meeting = await nextMeeting();
    let q = sb.from('agenda_items').select(ITEM_FIELDS).eq('tenant_id', TID).eq('covered', false);
    q = meeting ? q.or(`meeting_id.is.null,meeting_id.eq.${meeting.id}`) : q.is('meeting_id', null);
    const { data } = await q.order('created_at');
    return jsonResponse({ ok: true, meeting: meeting ? await one(meeting) : null, items: await shapeItems(data ?? []) });
  }

  if (action === 'add_item') {
    const problem = itemProblem(body.body);
    if (problem) return jsonResponse({ ok: false, error: problem }, 400);
    const { count } = await sb.from('agenda_items').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).is('meeting_id', null);
    if ((count ?? 0) >= 200) return jsonResponse({ ok: false, error: 'The list for the next meeting is full. Hold a meeting first.' }, 409);
    // Once the next meeting has its agenda, a new item joins it.
    const next = await nextMeeting();
    const { data: row, error } = await sb.from('agenda_items').insert({
      tenant_id: TID, body: cleanItem(body.body),
      added_by: payload.synthetic ? null : me.id, added_by_name: me.name,
      meeting_id: next?.agenda_created_at ? next.id : null,
    }).select(ITEM_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, item: (await shapeItems([row]))[0] });
  }

  if (action === 'update_item') {
    const { row, deny } = await changeableItem(String(body.id ?? ''));
    if (deny) return deny;
    const problem = itemProblem(body.body);
    if (problem) return jsonResponse({ ok: false, error: problem }, 400);
    const { data, error } = await sb.from('agenda_items').update({ body: cleanItem(body.body), updated_at: new Date().toISOString() })
      .eq('id', row!.id).eq('tenant_id', TID).select(ITEM_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, item: (await shapeItems([data]))[0] });
  }

  if (action === 'delete_item') {
    const { row, deny } = await changeableItem(String(body.id ?? ''));
    if (deny) return deny;
    await sb.from('agenda_items').delete().eq('id', row!.id).eq('tenant_id', TID);
    return jsonResponse({ ok: true });
  }

  // ── Create and view the agenda (PLAN.md L2) ─────────────────────────────
  // Anyone on the board. Builds from the items, the board positions, the
  // last minutes and open follow-ups, so it's always current.
  async function agendaFor(m: Record<string, unknown>) {
    let q = sb.from('agenda_items').select(ITEM_FIELDS).eq('tenant_id', TID);
    // Before the meeting, anything still waiting is on it too.
    q = m.status === 'draft' ? q.or(`meeting_id.eq.${m.id},meeting_id.is.null`) : q.eq('meeting_id', m.id as string);
    const [{ data: itemRows }, b, { data: past }] = await Promise.all([
      q.order('created_at'),
      loadBoard(sb as never, TID),
      sb.from('board_meetings').select('meeting_date, follow_ups_json')
        .eq('tenant_id', TID).eq('status', 'completed').lte('meeting_date', m.meeting_date as string)
        .neq('id', m.id as string).order('meeting_date', { ascending: false }).limit(24),
    ]);
    const shaped = await shapeItems(itemRows ?? []);
    const openFollowUps: FollowUp[] = [];
    for (const pm of past ?? []) {
      for (const f of (pm.follow_ups_json as Array<Record<string, unknown>> | null) ?? []) {
        if ((f.status ?? 'open') === 'open' && f.description) {
          openFollowUps.push({ description: String(f.description), assigned_to: (f.assigned_to as string) ?? null,
            due_date: (f.due_date as string) ?? null, meeting_date: pm.meeting_date as string });
        }
      }
    }
    const agenda = buildAgenda({
      meeting: m as never, positions: b.positions, holders: b.holders, logins: b.logins,
      items: shaped as unknown as AgendaItem[],
      lastMinutesDate: (past ?? [])[0]?.meeting_date as string ?? null,
      openFollowUps: openFollowUps.slice(0, 30),
    });
    const names = new Map(b.logins.map(l => [l.id, l.display_name || 'A board member']));
    return {
      agenda, text: agendaText(agenda), items: shaped,
      created_by_name: m.agenda_created_by ? names.get(m.agenda_created_by as string) ?? null : null,
      sent_by_name: m.agenda_sent_by ? names.get(m.agenda_sent_by as string) ?? null : null,
    };
  }

  if (action === 'create_agenda') {
    let meeting: Record<string, unknown> | null = null;
    if (body.meeting_id) {
      const { data } = await sb.from('board_meetings').select(FIELDS).eq('id', String(body.meeting_id)).eq('tenant_id', TID).maybeSingle();
      meeting = data;
      if (!meeting) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
      if (meeting.status !== 'draft') return jsonResponse({ ok: false, error: 'That meeting has already started.' }, 409);
    } else {
      meeting = await nextMeeting();
    }
    const time = String(body.planned_time ?? '').trim();
    const plannedTime = /^[0-2]\d:[0-5]\d$/.test(time) ? time : null;
    if (!meeting) {
      // Nothing planned: plan it now, from the date, time and place given.
      const date = String(body.meeting_date ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return jsonResponse({ ok: false, error: 'Pick the meeting date.' }, 400);
      if (date < poolToday(await tenantTimeZone(sb, TID))) return jsonResponse({ ok: false, error: 'Pick a date that hasn\'t passed.' }, 400);
      const { data, error } = await sb.from('board_meetings').insert({
        tenant_id: TID, title: 'Board Meeting', meeting_date: date, planned_time: plannedTime,
        location: strOrNull(body.location), status: 'draft', visibility: 'members',
        created_by: payload.synthetic ? null : me.id,
      }).select(FIELDS).single();
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      meeting = data;
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (!meeting.agenda_created_at) { patch.agenda_created_at = patch.updated_at; patch.agenda_created_by = payload.synthetic ? null : me.id; }
    if (plannedTime && !meeting.planned_time) patch.planned_time = plannedTime;
    if (body.location && !meeting.location) patch.location = strOrNull(body.location);
    const { data: updated, error: upErr } = await sb.from('board_meetings').update(patch)
      .eq('id', meeting.id as string).eq('tenant_id', TID).select(FIELDS).single();
    if (upErr) return jsonResponse({ ok: false, error: upErr.message }, 500);
    // Everything waiting is on this meeting's agenda now.
    await sb.from('agenda_items').update({ meeting_id: updated.id }).eq('tenant_id', TID).is('meeting_id', null).eq('covered', false);
    return jsonResponse({ ok: true, meeting: await one(updated), ...(await agendaFor(updated)) });
  }

  if (action === 'agenda') {
    const { data: m } = await sb.from('board_meetings').select(FIELDS).eq('id', String(body.meeting_id ?? '')).eq('tenant_id', TID).maybeSingle();
    if (!m) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    return jsonResponse({ ok: true, meeting: await one(m), ...(await agendaFor(m)) });
  }

  // ── Check an item off at the meeting (PLAN.md L4) ──────────────────────
  // Whoever can change the meeting (the note-taker, the president).
  if (action === 'cover_item') {
    const { data: it } = await sb.from('agenda_items').select('id, meeting_id').eq('id', String(body.id ?? '')).eq('tenant_id', TID).maybeSingle();
    if (!it || !it.meeting_id) return jsonResponse({ ok: false, error: 'That item isn\'t on a meeting yet.' }, 404);
    const { row: mt, deny } = await editable(it.meeting_id as string);
    if (deny) return deny;
    if (mt!.status === 'completed') return jsonResponse({ ok: false, error: 'That meeting is over.' }, 409);
    await sb.from('agenda_items').update({ covered: body.covered === true, updated_at: new Date().toISOString() }).eq('id', it.id);
    return jsonResponse({ ok: true, covered: body.covered === true });
  }

  // ── Send to the board (PLAN.md L3) ─────────────────────────────────────
  // Only when someone presses the button. Every board member (not gate-iPad
  // logins) gets a text or an email, their own preference, and a pop-up.
  if (action === 'send_agenda') {
    const { data: m } = await sb.from('board_meetings').select(FIELDS).eq('id', String(body.meeting_id ?? '')).eq('tenant_id', TID).maybeSingle();
    if (!m) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    if (!m.agenda_created_at) return jsonResponse({ ok: false, error: 'Create the agenda first.' }, 409);
    if (m.status === 'completed') return jsonResponse({ ok: false, error: 'That meeting is over.' }, 409);
    const [{ data: t }, { data: people }] = await Promise.all([
      sb.from('tenants').select('slug, display_name, plan').eq('id', TID).maybeSingle(),
      sb.from('admin_users').select('id, display_name, email, phone_e164, notify_pref, role_template, roles, active')
        .eq('tenant_id', TID).eq('active', true).order('display_name'),
    ]);
    const board = (people ?? []).filter(isBoardMember);
    // In the app only: a pop-up to each board member's phone, no text or
    // email (Doug, 2026-10-07). Who has pop-ups on decides who it reaches.
    const { data: subs } = await sb.from('admin_push_subscriptions').select('admin_user_id')
      .eq('tenant_id', TID).in('admin_user_id', board.length ? board.map(a => a.id as string) : ['00000000-0000-0000-0000-000000000000']);
    const withPush = new Set((subs ?? []).map(x => x.admin_user_id as string));
    const plan = board.map(a => ({ a, name: (a.display_name || a.email || 'Board member') as string, channel: withPush.has(a.id as string) ? 'popup' : null }));
    if (body.preview === true) {
      return jsonResponse({ ok: true, recipients: plan.map(p => ({ name: p.name, channel: p.channel })),
        already_sent_at: m.agenda_sent_at ?? null });
    }

    const when = `${longDate(m.meeting_date as string, true)}${m.planned_time ? ', ' + clock(m.planned_time as string) : ''}`;
    let popped = 0;
    try {
      const { pushBoard } = await import('../_shared/enqueue_task.ts');
      const r = await pushBoard({ tenant_id: TID, target_scopes: [], admin_ids: board.map(a => a.id as string),
        title: `Board meeting agenda: ${when}`, body: 'The agenda is up. Tap to read it.',
        url: `/club/admin/board-meetings.html#agenda=${m.id}`, tag: `agenda:${m.id}` });
      popped = Number((r as { sent?: number } | null)?.sent ?? 0);
    } catch (e) { console.error('agenda pop-up:', (e as Error).message); }
    const missed = plan.filter(p => !p.channel).map(p => p.name);
    const reached = plan.length - missed.length;
    const now = new Date().toISOString();
    const { data: updated } = await sb.from('board_meetings').update({ agenda_sent_at: now, agenda_sent_by: payload.synthetic ? null : me.id })
      .eq('id', m.id).eq('tenant_id', TID).select(FIELDS).single();
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'board_meeting.agenda_sent', entity_type: 'board_meeting', entity_id: m.id,
        summary: `${me.name} sent the agenda for the ${when} meeting to the board (pop-ups to ${reached}${missed.length ? `; notifications off: ${missed.join(', ')}` : ''})`,
        actor_id: payload.synthetic ? null : me.id, actor_kind: 'tenant_admin',
      });
    } catch { /* never block on the audit write */ }
    return jsonResponse({ ok: true, reached, popped, missed, meeting: updated ? await one(updated) : null });
  }

  // ── bylaws (K6) ─────────────────────────────────────────────────────────
  // Any board member reads them. The President, or whoever can edit the club's
  // policies (the Secretary), sets a new version; the old ones are kept.
  if (action === 'bylaws') {
    const { data: a } = await sb.from('admin_users').select('scopes').eq('id', me.id).maybeSingle();
    return jsonResponse({ ok: true, ...(await bylawsFor(sb, TID)),
      can_change: me.isOwner || ((a?.scopes as string[] | null) ?? []).includes('policies') });
  }
  if (action === 'set_bylaws') {
    const { data: a } = await sb.from('admin_users').select('scopes').eq('id', me.id).maybeSingle();
    if (!me.isOwner && !((a?.scopes as string[] | null) ?? []).includes('policies')) {
      return jsonResponse({ ok: false, error: 'Only the President or the Secretary can change the bylaws.' }, 403);
    }
    const url = String(body.url ?? '').trim();
    // Only a file the club uploaded (tenant_upload → club-assets); it moves to
    // the private club-docs folder just below.
    const ours = `${SUPABASE_URL}/storage/v1/object/public/club-assets/${TID}/`;
    if (!url.startsWith(ours) || !/\.pdf$/i.test(url)) {
      return jsonResponse({ ok: false, error: 'Upload the bylaws as a PDF.' }, 400);
    }
    const fileName = strOrNull(body.file_name)?.slice(0, 160) ?? 'Bylaws.pdf';
    const { data: row, error } = await sb.from('club_documents').insert({
      tenant_id: TID, kind: 'bylaws', url, file_name: fileName,
      uploaded_by: payload.synthetic ? null : me.id, uploaded_by_name: me.name,
    }).select(DOC_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Out of the public folder at once (BJ1): the bylaws are for members only.
    const moved = await moveToPrivate(sb, SUPABASE_URL, TID, row as DocRow);
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'bylaws.uploaded', entity_type: 'club_document', entity_id: row.id,
        summary: `${me.name} posted a new version of the bylaws (${fileName})`,
        actor_id: payload.synthetic ? null : me.id, actor_kind: 'tenant_admin',
      });
    } catch { /* never block on the audit write */ }
    const [shown] = await withLinks(sb, SUPABASE_URL, TID, [{ ...(row as DocRow), storage_path: moved }]);
    return jsonResponse({ ok: true, bylaws: shown });
  }

  // ── list ────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data, error } = await sb.from('board_meetings').select(FIELDS)
      .eq('tenant_id', TID)
      .order('meeting_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meetings: await decorate(data ?? []) });
  }

  // ── get ─────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data, error } = await sb.from('board_meetings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    return jsonResponse({ ok: true, meeting: await one(data) });
  }

  // ── list_active_admins — checkbox source for the attendance UI ──────────
  if (action === 'list_active_admins') {
    const { data } = await sb.from('admin_users')
      .select('id, display_name, email, role_template, roles, board_title, active')
      .eq('tenant_id', TID).eq('active', true)
      .order('display_name', { ascending: true });
    return jsonResponse({
      ok: true,
      admins: (data ?? []).filter(isBoardMember).map(a => ({
        id: a.id,
        name: a.display_name || a.email,
        role: (a.roles && a.roles[0]) || a.role_template || 'owner',
        board_title: a.board_title || null,
      })),
    });
  }

  // ── create ──────────────────────────────────────────────────────────────
  if (action === 'create') {
    const created_by = payload.synthetic ? null : me.id;
    const title = String(body.title ?? '').trim() || 'Board Meeting';
    let meeting_date = String(body.meeting_date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting_date)) {
      meeting_date = poolToday(await tenantTimeZone(sb, payload.tid));
    }
    const location = strOrNull(body.location);
    // "Start a meeting" creates and starts in one call; the older two-step
    // path (draft now, Start later) is still there for planning ahead.
    const startNow = body.start === true;

    const { data, error } = await sb.from('board_meetings').insert({
      tenant_id: TID,
      title, meeting_date, location,
      status: startNow ? 'in_progress' : 'draft',
      started_at: startNow ? new Date().toISOString() : null,
      visibility: 'members',   // board-only is a switch, for closed sessions
      created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (startNow) {
      // Started on the spot: anything waiting is on its agenda (PLAN.md L4).
      await sb.from('agenda_items').update({ meeting_id: data.id }).eq('tenant_id', TID).is('meeting_id', null).eq('covered', false);
    }
    return jsonResponse({ ok: true, meeting: await one(data) });
  }

  // ── start ───────────────────────────────────────────────────────────────
  // Idempotent: a second call on an already-in-progress meeting just returns
  // the row unchanged. Prevents accidental started_at clobber if the
  // secretary clicks twice.
  if (action === 'start') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    if (existing!.status === 'in_progress') return jsonResponse({ ok: true, meeting: await one(existing!) });
    if (existing!.status === 'completed') {
      return jsonResponse({ ok: false, error: 'Meeting is already finalized. Re-open it first.' }, 409);
    }
    const now = new Date().toISOString();
    const { data, error } = await sb.from('board_meetings').update({
      status: 'in_progress', started_at: now, updated_at: now,
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Anything still waiting is on this meeting's agenda, even if nobody
    // pressed Create agenda (PLAN.md L4).
    await sb.from('agenda_items').update({ meeting_id: id }).eq('tenant_id', TID).is('meeting_id', null).eq('covered', false);
    return jsonResponse({ ok: true, meeting: await one(data) });
  }

  // ── update — autosave for live note-taking ──────────────────────────────
  if (action === 'update') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    if (existing!.status === 'completed') {
      return jsonResponse({ ok: false, error: 'This meeting is closed. Use Save changes to fix it.' }, 409);
    }
    const { patch, bad } = contentPatch(body, { open: true });
    if (bad) return bad;

    const { data, error } = await sb.from('board_meetings').update(patch)
      .eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meeting: await one(data) });
  }

  // ── amend — fix closed minutes without re-opening them ─────────────────
  if (action === 'amend') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    const mode = editMode(existing!);
    if (mode === 'open') {
      return jsonResponse({ ok: false, error: 'This meeting is still open; its changes save as you type.' }, 409);
    }
    if (mode === 'locked') {
      return jsonResponse({ ok: false, error: 'These minutes are waiting for approval. Tap Edit again to change them (the approvals start over).' }, 409);
    }
    const { patch, bad } = contentPatch(body);
    if (bad) return bad;
    patch.edited_at = patch.updated_at;
    patch.edited_by = payload.synthetic ? null : me.id;
    // Approved minutes: the change is an amendment. They're a draft again and
    // go through the same approval; members keep the approved copy till then.
    if (mode === 'amend') Object.assign(patch, { minutes_status: 'draft' });

    const { data, error } = await sb.from('board_meetings').update(patch)
      .eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await audit(mode === 'amend' ? 'board_meeting.amendment_started' : 'board_meeting.edited', existing!,
      `${mode === 'amend' ? 'Started an amendment to approved minutes' : 'Edited minutes'}: "${existing!.title}" (${existing!.meeting_date})`);
    await syncFollowUpTasks(sb, data as MeetingForTasks, payload.synthetic ? null : me.id);
    return jsonResponse({ ok: true, meeting: await one(data) });
  }

  // ── finalize ───────────────────────────────────────────────────────────
  if (action === 'finalize') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    // A second tap must not move the real end time.
    if (existing!.status === 'completed') return jsonResponse({ ok: true, meeting: await one(existing!) });
    const now = new Date().toISOString();
    const { data, error } = await sb.from('board_meetings').update({
      status: 'completed',
      ended_at: now,
      updated_at: now,
      // Motions added but never used don't go in the minutes.
      votes_json: sanitizeVotes(existing!.votes_json),
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Follow-ups for board members go on their dashboards now.
    await syncFollowUpTasks(sb, data as MeetingForTasks, payload.synthetic ? null : me.id);
    // Agenda items nobody got to go back on the list for the next meeting,
    // marked where they came from (PLAN.md L4).
    await sb.from('agenda_items').update({ meeting_id: null, carried_from: id, updated_at: now })
      .eq('tenant_id', TID).eq('meeting_id', id).eq('covered', false);
    return jsonResponse({ ok: true, meeting: await one(data) });
  }

  // ── Minutes approval (PLAN.md BJ3) ─────────────────────────────────────
  if (action === 'submit_minutes') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    const m = existing!;
    if (m.status !== 'completed') return jsonResponse({ ok: false, error: 'Close the meeting first, then submit the minutes.' }, 409);
    if (m.minutes_status === 'submitted') return jsonResponse({ ok: true, meeting: await one(m) });
    if (m.minutes_status === 'approved') return jsonResponse({ ok: false, error: 'These minutes are already approved.' }, 409);
    // The board members who attended, with board logins that are still active.
    const { data: logins } = await sb.from('admin_users').select('id, role_template, roles, active').eq('tenant_id', TID);
    const boardIds = new Set((logins ?? []).filter(isBoardMember).map(a => a.id as string));
    const submitter = payload.synthetic ? null : me.id;
    const rows = approversFor((m.attendees_json ?? []) as Attendee[], boardIds, submitter);
    const round = Number(m.approval_round ?? 0) + 1;
    const now = new Date().toISOString();
    if (rows.length) {
      const { error } = await sb.from('board_minutes_approvals').insert(rows.map(r => ({
        tenant_id: TID, meeting_id: id, round, admin_id: r.admin_id, name: r.name, status: r.status,
        decided_at: r.status === 'approved' ? now : null, decided_by: r.status === 'approved' ? submitter : null,
        decided_by_name: r.status === 'approved' ? me.name : null,
      })));
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }
    const { data: upd, error } = await sb.from('board_meetings').update({
      minutes_status: 'submitted', approval_round: round, submitted_at: now, submitted_by: submitter,
      changes_note: null, changes_by_name: null, changes_at: null, updated_at: now,
    }).eq('id', id).eq('tenant_id', TID).eq('minutes_status', 'draft').select(FIELDS).maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!upd) return jsonResponse({ ok: true, meeting: await one(m) });   // someone submitted it a moment ago
    await closeMinutesTasks(id, ['minutes.changes']);
    const asked = rows.filter(r => r.status === 'pending');
    for (const r of asked) {
      await enqueueAdminTask(sb, {
        tenant_id: TID, target_scopes: [], assigned_admin_id: r.admin_id, kind: 'minutes.approve',
        summary: `Approve the minutes of ${meetingName(m)}`, link_url: minutesLink(id),
        source_kind: 'board_minutes', source_id: id,
        push_title: '📝 Minutes to approve', push_body: `${me.name} sent the minutes of ${meetingName(m)} for your approval.`,
      });
    }
    await audit('board_meeting.submitted', m, `${me.name} submitted the minutes of "${m.title}" (${m.meeting_date}) for approval: ${asked.map(r => r.name).join(', ') || 'nobody else attended'}`);
    return jsonResponse({ ok: true, meeting: await one(await postIfDone(upd)) });
  }

  if (action === 'approve_minutes' || action === 'approve_for') {
    const id = String(body.id ?? '');
    const { data: m } = await sb.from('board_meetings').select(FIELDS).eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!m) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    if (m.minutes_status !== 'submitted') return jsonResponse({ ok: false, error: 'These minutes aren\'t waiting for approval.' }, 409);
    const forOther = action === 'approve_for';
    if (forOther && !me.isOwner) return jsonResponse({ ok: false, error: 'Only the President can approve for someone.' }, 403);
    if (forOther && !mayApproveFor(true, m.submitted_at as string)) {
      return jsonResponse({ ok: false, error: `The President can approve for someone once the minutes have waited ${ON_BEHALF_DAYS} days.` }, 409);
    }
    const who = forOther ? String(body.admin_id ?? '') : me.id;
    const { data: row } = await sb.from('board_minutes_approvals').update({
      status: 'approved', decided_at: new Date().toISOString(), decided_by: payload.synthetic ? null : me.id,
      decided_by_name: me.name, on_behalf: forOther,
    }).eq('meeting_id', id).eq('round', m.approval_round).eq('admin_id', who).eq('status', 'pending').select('name').maybeSingle();
    if (!row) {
      return jsonResponse({ ok: false, error: forOther ? 'They have nothing waiting on these minutes.' : 'You\'re not one of the board members asked to approve these minutes.' }, 403);
    }
    await closeMinutesTasks(id, ['minutes.approve'], who);
    await audit(forOther ? 'board_meeting.approved_for' : 'board_meeting.minutes_approved', m,
      forOther ? `${me.name} approved the minutes of "${m.title}" (${m.meeting_date}) for ${row.name}`
               : `${me.name} approved the minutes of "${m.title}" (${m.meeting_date})`);
    return jsonResponse({ ok: true, meeting: await one(await postIfDone(m)) });
  }

  if (action === 'request_changes') {
    const id = String(body.id ?? '');
    const { data: m } = await sb.from('board_meetings').select(FIELDS).eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!m) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    if (m.minutes_status !== 'submitted') return jsonResponse({ ok: false, error: 'These minutes aren\'t waiting for approval.' }, 409);
    const note = String(body.note ?? '').trim().slice(0, 500);
    if (!note) return jsonResponse({ ok: false, error: 'Say what to change.' }, 400);
    const { data: mine } = await sb.from('board_minutes_approvals').select('id')
      .eq('meeting_id', id).eq('round', m.approval_round).eq('admin_id', me.id).eq('status', 'pending').maybeSingle();
    if (!mine && !me.isOwner) return jsonResponse({ ok: false, error: 'Only the board members asked to approve these minutes can ask for changes.' }, 403);
    const now = new Date().toISOString();
    const { data: upd } = await sb.from('board_meetings').update({
      minutes_status: 'draft', changes_note: note, changes_by_name: me.name, changes_at: now, updated_at: now,
    }).eq('id', id).eq('tenant_id', TID).eq('minutes_status', 'submitted').select(FIELDS).maybeSingle();
    if (!upd) return jsonResponse({ ok: false, error: 'These minutes changed a moment ago. Open them again.' }, 409);
    await voidRound(id, Number(m.approval_round));
    await closeMinutesTasks(id, ['minutes.approve']);
    if (m.created_by) {
      await enqueueAdminTask(sb, {
        tenant_id: TID, target_scopes: [], assigned_admin_id: m.created_by as string, kind: 'minutes.changes',
        summary: `Changes asked on the minutes of ${meetingName(m)}: ${note.slice(0, 140)}`, link_url: minutesLink(id),
        source_kind: 'board_minutes', source_id: id,
        push_title: '✏️ Changes asked on the minutes', push_body: `${me.name}: ${note.slice(0, 160)}`,
      });
    }
    await audit('board_meeting.changes_requested', m, `${me.name} asked for changes to the minutes of "${m.title}" (${m.meeting_date}): ${note}`);
    return jsonResponse({ ok: true, meeting: await one(upd) });
  }

  if (action === 'edit_again') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    const m = existing!;
    if (m.minutes_status !== 'submitted') return jsonResponse({ ok: true, meeting: await one(m) });
    const { data: upd } = await sb.from('board_meetings').update({ minutes_status: 'draft', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID).eq('minutes_status', 'submitted').select(FIELDS).maybeSingle();
    if (!upd) return jsonResponse({ ok: true, meeting: await one(m) });
    await voidRound(id, Number(m.approval_round));
    await closeMinutesTasks(id, ['minutes.approve']);
    await audit('board_meeting.edit_again', m, `${me.name} took back the minutes of "${m.title}" (${m.meeting_date}) to change them; approvals start over`);
    return jsonResponse({ ok: true, meeting: await one(upd) });
  }

  // ── delete ─────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = String(body.id ?? '');
    const { row: existing, deny } = await editable(id);
    if (deny) return deny;
    if (!canDeleteMeeting(existing!, me)) {
      return jsonResponse({ ok: false, error: 'Only the president can delete minutes once the meeting is closed.' }, 403);
    }
    if (existing!.status === 'completed') {
      await audit('board_meeting.deleted', existing!, `Deleted minutes: "${existing!.title}" (${existing!.meeting_date})`);
    }
    const { error } = await sb.from('board_meetings')
      .delete().eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await clearFollowUpTasks(sb, TID, id);
    await closeMinutesTasks(id, ['minutes.approve', 'minutes.changes']);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

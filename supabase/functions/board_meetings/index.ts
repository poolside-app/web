// =============================================================================
// board_meetings — Secretary's note-taking surface for board meetings
// =============================================================================
// Auth: tenant_admin token of a board member (_shared/board.ts). Any board
// member can start a meeting and read all minutes; only the note-taker
// (created_by) and the president can change one. Lifeguard / gate-iPad
// logins are refused. Public list is anonymous (slug-based).
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
//                                    // public, keeps its start/end times,
//                                    // sets edited_at/edited_by, and puts the
//                                    // old version in audit_log
//
//   { action: 'finalize', id }
//     → { ok, meeting }              // "Close meeting": status='completed',
//                                    // ended_at=now. A public meeting (the
//                                    // default) is on list_public from here.
//                                    // Closing twice keeps the first time.
//
//   { action: 'delete', id }
//     → { ok }                       // hard-delete. Once closed, president
//                                    // only, and a copy goes to audit_log.
//
// There is no 'reopen': it cleared the real end time and pulled the
// minutes off the public page while they were edited. amend replaced it.
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
//   { action: 'send_agenda', meeting_id, preview? }
//                                         → texts or emails it to every board
//                                           member (their preference) and pops
//                                           up; preview: true says who'd get
//                                           it how, and sends nothing
//
// Public action (no auth, used by the /governance.html public page):
//   { action: 'list_public', slug }
//     → { ok, meetings: [...] }      // only completed + visibility='public'
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { boardCaller, canDeleteMeeting, canEditMeeting, isBoardMember, type BoardCaller } from '../_shared/board.ts';
import { poolToday, tenantTimeZone } from '../_shared/pool_time.ts';
import { clearFollowUpTasks, syncFollowUpTasks, type MeetingForTasks } from '../_shared/meeting_follow_ups.ts';
import { cleanItem, itemProblem, buildAgenda, agendaText, agendaSms, sendChannel, longDate, clock, type AgendaItem, type FollowUp } from '../_shared/agenda.ts';
import { loadBoard } from '../_shared/positions_db.ts';
import { boardRoster } from '../_shared/positions.ts';

// The bylaws (PLAN.md K6): every upload is kept; the newest is current.
const DOC_FIELDS = 'id, url, file_name, uploaded_by_name, uploaded_at';
async function bylawsFor(sb: ReturnType<typeof createClient>, tenantId: string) {
  const { data } = await sb.from('club_documents').select(DOC_FIELDS)
    .eq('tenant_id', tenantId).eq('kind', 'bylaws').order('uploaded_at', { ascending: false }).limit(20);
  const rows = data ?? [];
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

const FIELDS = 'id, tenant_id, title, meeting_date, location, status, started_at, ended_at, visibility, notes_md, attendees_json, votes_json, follow_ups_json, created_by, created_at, updated_at, edited_at, edited_by, planned_time, agenda_created_at, agenda_created_by, agenda_sent_at, agenda_sent_by';
const PUBLIC_FIELDS = 'id, title, meeting_date, location, started_at, ended_at, notes_md, attendees_json, votes_json, follow_ups_json, edited_at, edited_by';
// What a correction can change, and what the audit log keeps of the old one.
const CONTENT = ['title', 'meeting_date', 'location', 'notes_md', 'attendees_json', 'votes_json', 'follow_ups_json', 'visibility'] as const;

const VALID_VIS = new Set(['private', 'public']);

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

function sanitizeVotes(input: unknown): Array<Record<string, unknown>> {
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
    if (!hasAnyData) return null;
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
function contentPatch(body: Record<string, unknown>): { patch: Record<string, unknown>; bad?: Response } {
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
  if (body.votes !== undefined)      patch.votes_json      = sanitizeVotes(body.votes);
  if (body.follow_ups !== undefined) patch.follow_ups_json = sanitizeFollowUps(body.follow_ups);
  if (body.visibility !== undefined) {
    const v = String(body.visibility);
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

  // ── list_public — anonymous, slug-keyed ────────────────────────────────
  // The /governance.html public page hits this; no auth required. Returns
  // ONLY completed + visibility='public' meetings, with admin-only fields
  // (created_by, internal status) stripped.
  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const { data, error } = await sb.from('board_meetings').select(PUBLIC_FIELDS)
      .eq('tenant_id', tenant.id)
      .eq('status', 'completed')
      .eq('visibility', 'public')
      .order('meeting_date', { ascending: false })
      .limit(100);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // "Edited Sep 30 by Kristin": the editor's name, never their login id.
    const editors = new Map<string, string>();
    const ids = [...new Set((data ?? []).map(m => m.edited_by).filter(Boolean))] as string[];
    if (ids.length) {
      const { data: who } = await sb.from('admin_users').select('id, display_name')
        .eq('tenant_id', tenant.id).in('id', ids);
      for (const a of who ?? []) editors.set(a.id, a.display_name || 'the board');
    }
    const meetings = (data ?? []).map(({ edited_by, ...m }) => ({
      ...m, edited_by_name: edited_by ? editors.get(edited_by) ?? 'the board' : null,
    }));
    // The bylaws, always public (K6), and who's on the board: names and
    // positions only. Job descriptions stay with the board.
    const b = await loadBoard(sb as never, tenant.id);
    return jsonResponse({
      ok: true, meetings,
      bylaws: await bylawsFor(sb, tenant.id),
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
    return rows.map(r => ({
      ...r,
      note_taker: r.created_by ? names.get(r.created_by as string) ?? null : null,
      edited_by_name: r.edited_by ? names.get(r.edited_by as string) ?? null : null,
      agenda_sent_by_name: r.agenda_sent_by ? names.get(r.agenda_sent_by as string) ?? null : null,
      can_edit: canEditMeeting(r as { created_by?: string | null }, me!),
      can_delete: canDeleteMeeting(r as { created_by?: string | null; status?: string }, me!),
    }));
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
        location: strOrNull(body.location), status: 'draft', visibility: 'public',
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
    const plan = board.map(a => ({ a, name: (a.display_name || a.email || 'Board member') as string, channel: sendChannel(a) }));
    if (body.preview === true) {
      return jsonResponse({ ok: true, recipients: plan.map(p => ({ name: p.name, channel: p.channel })),
        already_sent_at: m.agenda_sent_at ?? null });
    }

    const club = (t?.display_name as string) || 'Your pool';
    const clubUrl = `https://${t?.slug}.poolsideapp.com`;
    const link = `${clubUrl}/club/admin/board-meetings.html#agenda=${m.id}`;
    const { text: agendaTxt } = await agendaFor(m);
    const when = `${longDate(m.meeting_date as string, true)}${m.planned_time ? ', ' + clock(m.planned_time as string) : ''}`;
    const { sendSms } = await import('../_shared/send_sms.ts');
    const { sendEmail, emailShell, escHtml } = await import('../_shared/send_email.ts');
    const email = (to: string) => sendEmail({
      to, subject: `${club}: agenda for the ${when} board meeting`,
      html: emailShell({ tenantName: club, clubUrl, preheader: `The agenda for the ${when} board meeting`,
        contentHtml: `<p style="margin:0 0 12px">The agenda for the board meeting ${escHtml(when)}:</p>
          <pre style="white-space:pre-wrap;font:14px/1.6 Inter,Arial,sans-serif;background:#f8fafc;border-radius:10px;padding:14px 16px;margin:0 0 16px">${escHtml(agendaTxt)}</pre>
          <p style="margin:0"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0a3b5c;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Open the agenda</a></p>` }),
    });
    let texted = 0, emailed = 0;
    const missed: string[] = [];
    for (const p of plan) {
      let done = false;
      if (p.channel === 'text') {
        const r = await sendSms({ sb: sb as never, tenantId: TID, tenantPlan: t?.plan as string | null, to: p.a.phone_e164 as string,
          body: agendaSms(club, m.meeting_date as string, m.planned_time as string | null, link), kind: 'transactional', source: 'board_meetings.agenda' });
        if (r.sent) { texted++; done = true; }
      }
      // An email if that's their choice, or the text didn't go.
      if (!done && p.a.email && (p.channel === 'email' || p.channel === 'text')) {
        const r = await email(p.a.email as string);
        if (r.sent) { emailed++; done = true; }
      }
      if (!done) missed.push(p.name);
    }
    try {
      const { pushBoard } = await import('../_shared/enqueue_task.ts');
      await pushBoard({ tenant_id: TID, target_scopes: [], admin_ids: board.map(a => a.id as string),
        title: `Board meeting agenda: ${when}`, body: 'The agenda is up. Tap to read it.',
        url: `/club/admin/board-meetings.html#agenda=${m.id}`, tag: `agenda:${m.id}` });
    } catch { /* the texts and emails are what count */ }
    const now = new Date().toISOString();
    const { data: updated } = await sb.from('board_meetings').update({ agenda_sent_at: now, agenda_sent_by: payload.synthetic ? null : me.id })
      .eq('id', m.id).eq('tenant_id', TID).select(FIELDS).single();
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'board_meeting.agenda_sent', entity_type: 'board_meeting', entity_id: m.id,
        summary: `${me.name} sent the agenda for the ${when} meeting to the board (${texted} by text, ${emailed} by email${missed.length ? `, not reached: ${missed.join(', ')}` : ''})`,
        actor_id: payload.synthetic ? null : me.id, actor_kind: 'tenant_admin',
      });
    } catch { /* never block on the audit write */ }
    return jsonResponse({ ok: true, texted, emailed, missed, meeting: updated ? await one(updated) : null });
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
    // Only a file the club uploaded (tenant_upload → public club-assets).
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
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'bylaws.uploaded', entity_type: 'club_document', entity_id: row.id,
        summary: `${me.name} posted a new version of the bylaws (${fileName})`,
        actor_id: payload.synthetic ? null : me.id, actor_kind: 'tenant_admin',
      });
    } catch { /* never block on the audit write */ }
    return jsonResponse({ ok: true, bylaws: row });
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
      visibility: 'public',   // board-only is a switch, for closed sessions
      created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
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
    const { patch, bad } = contentPatch(body);
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
    if (existing!.status !== 'completed') {
      return jsonResponse({ ok: false, error: 'This meeting is still open; its changes save as you type.' }, 409);
    }
    const { patch, bad } = contentPatch(body);
    if (bad) return bad;
    patch.edited_at = patch.updated_at;
    patch.edited_by = payload.synthetic ? null : me.id;

    const { data, error } = await sb.from('board_meetings').update(patch)
      .eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await audit('board_meeting.edited', existing!, `Edited minutes: "${existing!.title}" (${existing!.meeting_date})`);
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
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Follow-ups for board members go on their dashboards now.
    await syncFollowUpTasks(sb, data as MeetingForTasks, payload.synthetic ? null : me.id);
    return jsonResponse({ ok: true, meeting: await one(data) });
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
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

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
// Public action (no auth, used by the /governance.html public page):
//   { action: 'list_public', slug }
//     → { ok, meetings: [...] }      // only completed + visibility='public'
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { boardCaller, canDeleteMeeting, canEditMeeting, isBoardMember, type BoardCaller } from '../_shared/board.ts';
import { poolToday, tenantTimeZone } from '../_shared/pool_time.ts';
import { clearFollowUpTasks, syncFollowUpTasks, type MeetingForTasks } from '../_shared/meeting_follow_ups.ts';

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

const FIELDS = 'id, tenant_id, title, meeting_date, location, status, started_at, ended_at, visibility, notes_md, attendees_json, votes_json, follow_ups_json, created_by, created_at, updated_at, edited_at, edited_by';
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
    return jsonResponse({ ok: true, meetings });
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
    const ids = [...new Set(rows.flatMap(r => [r.created_by, r.edited_by]).filter(Boolean))] as string[];
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

// =============================================================================
// board_meetings — Secretary's note-taking surface for board meetings
// =============================================================================
// Auth: tenant_admin token. Most actions require the 'meetings' scope (or
// owner). Public list is anonymous (slug-based).
//
// Admin actions:
//   { action: 'list' }
//     → { ok, meetings: [...] }     // newest-first, all statuses
//
//   { action: 'get', id }
//     → { ok, meeting }
//
//   { action: 'create', title?, meeting_date?, location? }
//     → { ok, meeting }              // status='draft' until 'start' is called
//
//   { action: 'start', id }
//     → { ok, meeting }              // status='in_progress', started_at=now
//
//   { action: 'update', id, ...partial fields }
//     → { ok, meeting }              // autosave; reject if status='completed'
//                                    // unless 'reopen' was called first.
//
//   { action: 'finalize', id }
//     → { ok, meeting }              // status='completed', ended_at=now
//
//   { action: 'reopen', id }
//     → { ok, meeting }              // unlocks a completed meeting for edits
//
//   { action: 'delete', id }
//     → { ok }                       // hard-delete; secretary can rebuild
//
//   { action: 'list_active_admins' }
//     → { ok, admins: [{id, name, role_label}] }
//                                    // Helper for the attendance checkbox list
//
// Public action (no auth, used by the /governance.html public page):
//   { action: 'list_public', slug }
//     → { ok, meetings: [...] }      // only completed + visibility='public'
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope } from '../_shared/auth.ts';

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

const FIELDS = 'id, tenant_id, title, meeting_date, location, status, started_at, ended_at, visibility, notes_md, attendees_json, votes_json, follow_ups_json, created_by, created_at, updated_at';
const PUBLIC_FIELDS = 'id, title, meeting_date, location, started_at, ended_at, notes_md, attendees_json, votes_json, follow_ups_json';

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
    if (!motion) return null;
    const outcome = String(r.outcome ?? 'pending');
    return {
      id: r.id ? String(r.id).slice(0, 40) : crypto.randomUUID(),
      motion,
      proposed_by: String(r.proposed_by ?? '').trim().slice(0, 120) || null,
      seconded_by: String(r.seconded_by ?? '').trim().slice(0, 120) || null,
      yes:     Math.max(0, Math.trunc(Number(r.yes ?? 0)) || 0),
      no:      Math.max(0, Math.trunc(Number(r.no ?? 0)) || 0),
      abstain: Math.max(0, Math.trunc(Number(r.abstain ?? 0)) || 0),
      outcome: VALID_OUT.has(outcome) ? outcome : 'pending',
      notes:   String(r.notes ?? '').trim().slice(0, 2000) || null,
    };
  }).filter((x): x is Record<string, unknown> => !!x);
}

function sanitizeFollowUps(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const VALID_S = new Set(['open', 'done', 'cancelled']);
  return input.slice(0, 100).map(raw => {
    const r = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const description = String(r.description ?? '').trim().slice(0, 500);
    if (!description) return null;
    const status = String(r.status ?? 'open');
    let due_date: string | null = null;
    if (r.due_date) {
      const s = String(r.due_date).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) due_date = s;
    }
    return {
      id: r.id ? String(r.id).slice(0, 40) : crypto.randomUUID(),
      description,
      assigned_to: String(r.assigned_to ?? '').trim().slice(0, 120) || null,
      due_date,
      status: VALID_S.has(status) ? status : 'open',
    };
  }).filter((x): x is Record<string, unknown> => !!x);
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
    return jsonResponse({ ok: true, meetings: data ?? [] });
  }

  // ── Admin-only actions below ───────────────────────────────────────────
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(sb, payload as never, 'meetings'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: meetings' }, 403);
  }
  const TID = payload.tid;

  // ── list ────────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data, error } = await sb.from('board_meetings').select(FIELDS)
      .eq('tenant_id', TID)
      .order('meeting_date', { ascending: false })
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meetings: data ?? [] });
  }

  // ── get ─────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data, error } = await sb.from('board_meetings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    return jsonResponse({ ok: true, meeting: data });
  }

  // ── list_active_admins — checkbox source for the attendance UI ──────────
  if (action === 'list_active_admins') {
    const { data } = await sb.from('admin_users')
      .select('id, display_name, email, role_template, roles, active')
      .eq('tenant_id', TID).eq('active', true)
      .order('display_name', { ascending: true });
    return jsonResponse({
      ok: true,
      admins: (data ?? []).map(a => ({
        id: a.id,
        name: a.display_name || a.email,
        role: (a.roles && a.roles[0]) || a.role_template || 'owner',
      })),
    });
  }

  // ── create ──────────────────────────────────────────────────────────────
  if (action === 'create') {
    const created_by = payload.synthetic ? null : payload.sub;
    const title = String(body.title ?? '').trim() || 'Board Meeting';
    let meeting_date = String(body.meeting_date ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting_date)) {
      meeting_date = new Date().toISOString().slice(0, 10);
    }
    const location = strOrNull(body.location);

    const { data, error } = await sb.from('board_meetings').insert({
      tenant_id: TID,
      title, meeting_date, location,
      status: 'draft',
      created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meeting: data });
  }

  // ── start ───────────────────────────────────────────────────────────────
  // Idempotent: a second call on an already-in-progress meeting just returns
  // the row unchanged. Prevents accidental started_at clobber if the
  // secretary clicks twice.
  if (action === 'start') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: existing } = await sb.from('board_meetings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!existing) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    if (existing.status === 'in_progress') return jsonResponse({ ok: true, meeting: existing });
    if (existing.status === 'completed') {
      return jsonResponse({ ok: false, error: 'Meeting is already finalized. Re-open it first.' }, 409);
    }
    const now = new Date().toISOString();
    const { data, error } = await sb.from('board_meetings').update({
      status: 'in_progress', started_at: now, updated_at: now,
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meeting: data });
  }

  // ── update — autosave for live note-taking ──────────────────────────────
  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: existing } = await sb.from('board_meetings').select('status')
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!existing) return jsonResponse({ ok: false, error: 'Meeting not found' }, 404);
    if (existing.status === 'completed') {
      return jsonResponse({ ok: false, error: 'Meeting is finalized. Re-open it before editing.' }, 409);
    }

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
      if (!VALID_VIS.has(v)) return jsonResponse({ ok: false, error: 'invalid visibility' }, 400);
      patch.visibility = v;
    }

    const { data, error } = await sb.from('board_meetings').update(patch)
      .eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meeting: data });
  }

  // ── finalize ───────────────────────────────────────────────────────────
  if (action === 'finalize') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const now = new Date().toISOString();
    const { data, error } = await sb.from('board_meetings').update({
      status: 'completed',
      ended_at: now,
      updated_at: now,
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meeting: data });
  }

  // ── reopen ─────────────────────────────────────────────────────────────
  // Lets a finalized meeting be edited again. Status goes back to
  // in_progress (not draft) since it has real content. ended_at is cleared.
  if (action === 'reopen') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data, error } = await sb.from('board_meetings').update({
      status: 'in_progress',
      ended_at: null,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, meeting: data });
  }

  // ── delete ─────────────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('board_meetings')
      .delete().eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

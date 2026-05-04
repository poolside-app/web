// =============================================================================
// events_admin — Per-tenant calendar CRUD
// =============================================================================
// Auth: tenant admin token. Tenant scope is the JWT's tid.
//
// Actions:
//   { action: 'list', range?: 'upcoming' | 'past' | 'all' }
//     → { ok, events: [...] }
//
//   { action: 'create', title, starts_at, ends_at?, body?, kind?, location?, all_day? }
//     → { ok, event }
//
//   { action: 'update', id, ...patch }
//     → { ok, event }
//
//   { action: 'delete', id }   // soft delete (active=false)
//     → { ok }
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
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin' || !payload.sub || !payload.tid) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

const VALID_KINDS = new Set(['event','party','swim_meet','social','closure','holiday','lesson','meeting']);
const VALID_RECURRENCE = new Set(['weekly', 'monthly']);
const FIELDS = 'id, tenant_id, title, body, kind, location, starts_at, ends_at, all_day, active, recurrence, recurrence_until, created_at, updated_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // Scope gate: this function's admin actions require the 'events' scope.
  // Synthetic webhook tokens bypass; super + owner roles bypass.
  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(createClient(SUPABASE_URL, SERVICE_ROLE), payload as never, 'events'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: events' }, 403);
  }
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    const range = String(body.range ?? 'all');
    let q = sb.from('events').select(FIELDS).eq('tenant_id', TID).eq('active', true);
    const now = new Date().toISOString();
    if (range === 'upcoming') q = q.gte('starts_at', now).order('starts_at', { ascending: true });
    else if (range === 'past') q = q.lt('starts_at', now).order('starts_at', { ascending: false });
    else q = q.order('starts_at', { ascending: true });
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, events: data ?? [] });
  }

  if (action === 'create') {
    const title     = String(body.title ?? '').trim();
    const starts_at = isoOrNull(body.starts_at);
    if (!title)     return jsonResponse({ ok: false, error: 'Title is required' }, 400);
    if (!starts_at) return jsonResponse({ ok: false, error: 'Start time is required' }, 400);
    if (title.length > 140) return jsonResponse({ ok: false, error: 'Title too long (max 140)' }, 400);

    const ends_at = isoOrNull(body.ends_at);
    if (ends_at && new Date(ends_at) < new Date(starts_at)) {
      return jsonResponse({ ok: false, error: 'End time must be on or after start time' }, 400);
    }
    const kind = strOrNull(body.kind) ?? 'event';
    if (!VALID_KINDS.has(kind)) {
      return jsonResponse({ ok: false, error: `Invalid kind. Pick from: ${[...VALID_KINDS].join(', ')}` }, 400);
    }

    const created_by = payload.synthetic ? null : payload.sub;
    const recurrence = strOrNull(body.recurrence);
    if (recurrence && !VALID_RECURRENCE.has(recurrence)) {
      return jsonResponse({ ok: false, error: 'Recurrence must be weekly or monthly' }, 400);
    }
    const recurrence_until = isoOrNull(body.recurrence_until);
    const { data, error } = await sb.from('events').insert({
      tenant_id: TID, title, starts_at, ends_at,
      body:      strOrNull(body.body),
      location:  strOrNull(body.location),
      kind,
      all_day:   !!body.all_day,
      recurrence,
      recurrence_until,
      created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, event: data });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.title !== undefined) {
      const v = String(body.title ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Title cannot be empty' }, 400);
      if (v.length > 140) return jsonResponse({ ok: false, error: 'Title too long' }, 400);
      patch.title = v;
    }
    if (body.body     !== undefined) patch.body     = strOrNull(body.body);
    if (body.location !== undefined) patch.location = strOrNull(body.location);
    if (body.kind     !== undefined) {
      const k = strOrNull(body.kind) ?? 'event';
      if (!VALID_KINDS.has(k)) return jsonResponse({ ok: false, error: 'Invalid kind' }, 400);
      patch.kind = k;
    }
    if (body.starts_at !== undefined) {
      const s = isoOrNull(body.starts_at);
      if (!s) return jsonResponse({ ok: false, error: 'Invalid starts_at' }, 400);
      patch.starts_at = s;
    }
    if (body.ends_at  !== undefined) patch.ends_at  = isoOrNull(body.ends_at);
    if (body.all_day  !== undefined) patch.all_day  = !!body.all_day;
    if (body.active   !== undefined) patch.active   = !!body.active;
    if (body.recurrence !== undefined) {
      const r = strOrNull(body.recurrence);
      if (r && !VALID_RECURRENCE.has(r)) return jsonResponse({ ok: false, error: 'Recurrence must be weekly or monthly' }, 400);
      patch.recurrence = r;
    }
    if (body.recurrence_until !== undefined) patch.recurrence_until = isoOrNull(body.recurrence_until);

    const { data, error } = await sb.from('events')
      .update(patch).eq('id', id).eq('tenant_id', TID)
      .select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, event: data });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('events')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

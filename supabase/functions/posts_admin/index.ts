// =============================================================================
// posts_admin — Per-tenant announcements CRUD
// =============================================================================
// Auth: tenant admin token. Tenant scope is the JWT's tid.
//
// Actions:
//   { action: 'list' }
//     → { ok, posts: [...] }     // includes inactive (soft-deleted)
//
//   { action: 'create', title, body, pinned? }
//     → { ok, post }
//
//   { action: 'update', id, ...patch }
//     → { ok, post }
//
//   { action: 'delete', id }      // soft delete (active=false)
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

const FIELDS = 'id, tenant_id, title, body, pinned, published_at, active, created_at, updated_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // Scope gate: this function's admin actions require the 'announcements' scope.
  // Synthetic webhook tokens bypass; super + owner roles bypass.
  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(createClient(SUPABASE_URL, SERVICE_ROLE), payload as never, 'announcements'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: announcements' }, 403);
  }
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    const { data, error } = await sb.from('posts').select(FIELDS)
      .eq('tenant_id', TID)
      .order('pinned', { ascending: false })
      .order('published_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, posts: data ?? [] });
  }

  if (action === 'create') {
    const title = String(body.title ?? '').trim();
    const text  = String(body.body ?? '').trim();
    if (!title) return jsonResponse({ ok: false, error: 'Title is required' }, 400);
    if (!text)  return jsonResponse({ ok: false, error: 'Body is required' }, 400);
    if (title.length > 140) return jsonResponse({ ok: false, error: 'Title too long (max 140 chars)' }, 400);
    if (text.length > 4000)  return jsonResponse({ ok: false, error: 'Body too long (max 4000 chars)' }, 400);

    // created_by is nullable — synthetic impersonation tokens leave it null
    // since payload.sub is the provider admin's id, not an admin_users row.
    const created_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('posts').insert({
      tenant_id: TID, title, body: text,
      pinned: !!body.pinned,
      created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, post: data });
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
    if (body.body !== undefined) {
      const v = String(body.body ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Body cannot be empty' }, 400);
      if (v.length > 4000) return jsonResponse({ ok: false, error: 'Body too long' }, 400);
      patch.body = v;
    }
    if (body.pinned !== undefined) patch.pinned = !!body.pinned;
    if (body.active !== undefined) patch.active = !!body.active;

    const { data, error } = await sb.from('posts')
      .update(patch).eq('id', id).eq('tenant_id', TID)
      .select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, post: data });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('posts')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

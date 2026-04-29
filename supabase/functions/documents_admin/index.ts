// =============================================================================
// documents_admin — Per-tenant document CRUD
// =============================================================================
// Auth: tenant admin token. Files are uploaded via tenant_upload (which now
// accepts PDFs in addition to images), then the URL + metadata is recorded
// here.
//
// Actions:
//   { action: 'list' }
//     → { ok, documents: [...] }    // includes inactive (soft-deleted)
//   { action: 'create', url, title, description?, visibility?, sort_order? }
//     → { ok, document }
//   { action: 'update', id, title?, description?, visibility?, sort_order?, active? }
//     → { ok, document }
//   { action: 'delete', id }        // soft delete (active=false)
//     → { ok }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

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

const VALID_VIS = new Set(['public', 'members', 'admins']);
const FIELDS = 'id, tenant_id, title, description, url, visibility, sort_order, active, created_at, updated_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    const { data, error } = await sb.from('documents').select(FIELDS)
      .eq('tenant_id', TID)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, documents: data ?? [] });
  }

  if (action === 'create') {
    const url = String(body.url ?? '').trim();
    const title = String(body.title ?? '').trim();
    if (!url) return jsonResponse({ ok: false, error: 'url required' }, 400);
    if (!/^https?:\/\//i.test(url)) return jsonResponse({ ok: false, error: 'url must start with http(s)' }, 400);
    if (!title) return jsonResponse({ ok: false, error: 'title required' }, 400);
    const visibility = String(body.visibility ?? 'public');
    if (!VALID_VIS.has(visibility)) return jsonResponse({ ok: false, error: 'invalid visibility' }, 400);

    const created_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('documents').insert({
      tenant_id: TID, url, title,
      description: strOrNull(body.description),
      visibility,
      sort_order: Math.trunc(Number(body.sort_order) || 0),
      created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, document: data });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.title       !== undefined) {
      const v = String(body.title ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'title cannot be empty' }, 400);
      patch.title = v;
    }
    if (body.description !== undefined) patch.description = strOrNull(body.description);
    if (body.visibility  !== undefined) {
      const v = String(body.visibility);
      if (!VALID_VIS.has(v)) return jsonResponse({ ok: false, error: 'invalid visibility' }, 400);
      patch.visibility = v;
    }
    if (body.sort_order  !== undefined) patch.sort_order = Math.trunc(Number(body.sort_order) || 0);
    if (body.active      !== undefined) patch.active = !!body.active;

    const { data, error } = await sb.from('documents')
      .update(patch).eq('id', id).eq('tenant_id', TID)
      .select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, document: data });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('documents')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

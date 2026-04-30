// =============================================================================
// policies — per-tenant policy text editing + public read
// =============================================================================
// Public actions (no auth):
//   { action: 'list_public', slug }
//     → { ok, policies: [...] }      — only active, ordered by sort_order
//
// Admin actions (tenant_admin JWT):
//   { action: 'list' }
//   { action: 'create', slug, title, body, required_for_apply?, sort_order? }
//   { action: 'update', id, ...patch }
//   { action: 'delete', id }                    — soft delete (active=false)
//   { action: 'reorder', order: [id1, id2, …] } — bulk sort_order assignment
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

type Payload = { sub: string; kind: string; tid: string };
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

const FIELDS = 'id, tenant_id, slug, title, body, required_for_apply, sort_order, active, updated_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    const { data, error } = await sb.from('policies').select(FIELDS)
      .eq('tenant_id', tenant.id).eq('active', true)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, policies: data ?? [] });
  }

  // Admin actions
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  if (action === 'list') {
    const { data, error } = await sb.from('policies').select(FIELDS)
      .eq('tenant_id', TID)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, policies: data ?? [] });
  }

  if (action === 'create') {
    const title = String(body.title ?? '').trim();
    const body_text = String(body.body ?? '').trim();
    if (!title) return jsonResponse({ ok: false, error: 'Title is required' }, 400);
    if (!body_text) return jsonResponse({ ok: false, error: 'Body is required' }, 400);
    if (title.length > 140) return jsonResponse({ ok: false, error: 'Title too long' }, 400);
    const slug = strOrNull(body.slug) ?? slugify(title);
    if (!slug) return jsonResponse({ ok: false, error: 'Couldn\'t derive a slug from the title' }, 400);

    // Compute sort_order = max+1 unless caller specified
    let sort_order: number;
    if (body.sort_order !== undefined && body.sort_order !== null && body.sort_order !== '') {
      sort_order = Math.max(0, Math.trunc(Number(body.sort_order) || 0));
    } else {
      const { data: maxRow } = await sb.from('policies').select('sort_order')
        .eq('tenant_id', TID).order('sort_order', { ascending: false }).limit(1).maybeSingle();
      sort_order = ((maxRow?.sort_order ?? 0) as number) + 1;
    }

    const { data, error } = await sb.from('policies').insert({
      tenant_id: TID, slug, title, body: body_text,
      required_for_apply: body.required_for_apply !== false,
      sort_order,
    }).select(FIELDS).single();
    if (error) {
      if (String(error.message).toLowerCase().includes('unique')) {
        return jsonResponse({ ok: false, error: 'A policy with that slug already exists — pick a different title' }, 409);
      }
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
    return jsonResponse({ ok: true, policy: data });
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
      patch.body = v;
    }
    if (body.required_for_apply !== undefined) patch.required_for_apply = !!body.required_for_apply;
    if (body.sort_order !== undefined) patch.sort_order = Math.max(0, Math.trunc(Number(body.sort_order) || 0));
    if (body.active !== undefined) patch.active = !!body.active;
    if (Object.keys(patch).length === 1) return jsonResponse({ ok: true, noop: true });

    const { data, error } = await sb.from('policies').update(patch)
      .eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, policy: data });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('policies').update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'reorder') {
    const order = Array.isArray(body.order) ? body.order as string[] : null;
    if (!order || !order.length) return jsonResponse({ ok: false, error: 'order array required' }, 400);
    // Update each row's sort_order to its index in the array
    const updates = order.map((id, i) =>
      sb.from('policies').update({ sort_order: i + 1, updated_at: new Date().toISOString() })
        .eq('id', String(id)).eq('tenant_id', TID),
    );
    const results = await Promise.all(updates);
    const firstErr = results.find(r => r.error)?.error;
    if (firstErr) return jsonResponse({ ok: false, error: firstErr.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

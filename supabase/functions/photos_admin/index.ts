// =============================================================================
// photos_admin — Per-tenant photo gallery CRUD
// =============================================================================
// Auth: tenant admin token. Uploads happen via tenant_upload (which writes
// to the public club-assets bucket); this function records the resulting
// URL + caption + ordering against the tenant.
//
// Actions:
//   { action: 'list' }
//     → { ok, photos: [...] }     // includes inactive (soft-deleted)
//
//   { action: 'create', url, caption? }
//     → { ok, photo }
//
//   { action: 'update', id, caption?, sort_order?, active? }
//     → { ok, photo }
//
//   { action: 'delete', id }      // soft delete (active=false)
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

const FIELDS = 'id, tenant_id, url, caption, sort_order, active, created_at, updated_at, status, uploaded_by_kind, uploaded_by_member_id, uploader_name, approved_at, approved_by, rejected_at, rejected_by, rejected_reason';

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
    // Default to approved-only (the gallery view). Pass status='all' to see
    // every row, or status='pending'/'rejected' to filter.
    const status = String(body.status ?? 'approved');
    let q = sb.from('photos').select(FIELDS).eq('tenant_id', TID);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, photos: data ?? [] });
  }

  if (action === 'list_pending') {
    const { data, error } = await sb.from('photos').select(FIELDS)
      .eq('tenant_id', TID).eq('active', true).eq('status', 'pending')
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, photos: data ?? [] });
  }

  if (action === 'pending_count') {
    const { count } = await sb.from('photos').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('active', true).eq('status', 'pending');
    return jsonResponse({ ok: true, count: count ?? 0 });
  }

  if (action === 'approve') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const approved_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('photos').update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      approved_by,
      rejected_at: null, rejected_by: null, rejected_reason: null,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Close any pending-approval admin task
    await sb.from('admin_tasks').update({ completed_at: new Date().toISOString(), completed_by: approved_by })
      .eq('tenant_id', TID).eq('source_kind', 'photo').eq('source_id', id).is('completed_at', null);
    return jsonResponse({ ok: true, photo: data });
  }

  if (action === 'reject') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const reason = strOrNull(body.reason);
    const rejected_by = payload.synthetic ? null : payload.sub;
    const { error } = await sb.from('photos').update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      rejected_by,
      rejected_reason: reason,
      active: false,             // hide from any list that filters on active
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('admin_tasks').update({ completed_at: new Date().toISOString(), completed_by: rejected_by })
      .eq('tenant_id', TID).eq('source_kind', 'photo').eq('source_id', id).is('completed_at', null);
    return jsonResponse({ ok: true });
  }

  if (action === 'create') {
    const url = String(body.url ?? '').trim();
    if (!url) return jsonResponse({ ok: false, error: 'url is required' }, 400);
    if (!/^https?:\/\//i.test(url)) return jsonResponse({ ok: false, error: 'url must start with http(s)' }, 400);

    const created_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('photos').insert({
      tenant_id: TID, url,
      caption: strOrNull(body.caption),
      sort_order: 0,
      created_by,
      status: 'approved',                // admin uploads are auto-approved
      uploaded_by_kind: 'admin',
      approved_at: new Date().toISOString(),
      approved_by: created_by,
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, photo: data });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.caption    !== undefined) patch.caption    = strOrNull(body.caption);
    if (body.sort_order !== undefined) patch.sort_order = Math.trunc(Number(body.sort_order) || 0);
    if (body.active     !== undefined) patch.active     = !!body.active;

    const { data, error } = await sb.from('photos')
      .update(patch).eq('id', id).eq('tenant_id', TID)
      .select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, photo: data });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('photos')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

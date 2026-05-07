// =============================================================================
// sponsors_admin — Per-tenant sponsor CRUD
// =============================================================================
// Admin-only. Public-facing sponsors are surfaced through tenant_public so
// the home pages can render the strip + popup without an extra round-trip.
//
// Actions:
//   { action: 'list' }
//   { action: 'create', sponsor: {...} }
//   { action: 'update', id, patch: {...} }
//   { action: 'delete', id }
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

type AdminPayload = { sub: string; kind: string; tid: string };
async function verifyTenantAdmin(token: string): Promise<AdminPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as AdminPayload;
  } catch { return null; }
}

// Browsers treat a bare hostname like "google.com" as a relative path,
// which 404s on the tenant's subdomain. Auto-prefix https:// when saving
// so admins don't have to think about it.
function normalizeUrl(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^\/\//.test(trimmed))         return 'https:' + trimmed;
  return 'https://' + trimmed;
}

function sanitizeSponsor(input: Record<string, unknown>): Record<string, unknown> {
  const name        = String(input.name ?? '').trim();
  const logo_url    = (input.logo_url    ? normalizeUrl(String(input.logo_url)) : null) || null;
  const link_url    = (input.link_url    ? normalizeUrl(String(input.link_url)) : null) || null;
  const description = (input.description ? String(input.description).trim().slice(0, 2000) : null) || null;
  const tier        = String(input.tier ?? 'basic') === 'premium' ? 'premium' : 'basic';
  const paid_through = (input.paid_through && String(input.paid_through).match(/^\d{4}-\d{2}-\d{2}$/))
    ? String(input.paid_through) : null;
  const sort_order  = Number.isFinite(Number(input.sort_order)) ? Math.trunc(Number(input.sort_order)) : 0;
  const active      = input.active === undefined ? true : !!input.active;
  return { name, logo_url, link_url, description, tier, paid_through, sort_order, active };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const admin = token ? await verifyTenantAdmin(token) : null;
  if (!admin) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    const { data, error } = await sb.from('sponsors')
      .select('id, name, logo_url, link_url, description, tier, paid_through, sort_order, active, created_at, updated_at')
      .eq('tenant_id', admin.tid)
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, sponsors: data ?? [] });
  }

  if (action === 'create') {
    const sp = sanitizeSponsor((body.sponsor as Record<string, unknown>) ?? {});
    if (!sp.name) return jsonResponse({ ok: false, error: 'Sponsor name is required' }, 400);
    const { data, error } = await sb.from('sponsors')
      .insert({ tenant_id: admin.tid, ...sp })
      .select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, id: data.id });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const patch = sanitizeSponsor((body.patch as Record<string, unknown>) ?? {});
    if (!patch.name) return jsonResponse({ ok: false, error: 'Name cannot be empty' }, 400);
    const { error } = await sb.from('sponsors')
      .update(patch).eq('id', id).eq('tenant_id', admin.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('sponsors')
      .delete().eq('id', id).eq('tenant_id', admin.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// =============================================================================
// campaigns — Per-tenant in-app pop-up CRUD + public read
// =============================================================================
// Public actions (no auth):
//   { action: 'list_active', slug, audience? }
//     → { ok, campaigns: [...] } — only active + within window
//
// Admin actions (tenant_admin JWT):
//   { action: 'list' }                        → all (active + inactive)
//   { action: 'create', title, ... }          → { ok, campaign }
//   { action: 'update', id, ...patch }        → { ok, campaign }
//   { action: 'delete', id }                  → ok (soft delete)
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

const VALID_KIND     = new Set(['announcement','event','fundraiser','signup']);
const VALID_AUDIENCE = new Set(['members','public','both']);
const FIELDS = 'id, tenant_id, title, body, emoji, kind, cta_label, cta_url, audience, starts_at, ends_at, active, created_at, updated_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── Public list (no auth) ───────────────────────────────────────────────
  if (action === 'list_active') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const wantAudience = String(body.audience ?? 'public');  // 'public' | 'members'
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants')
      .select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    const now = new Date().toISOString();
    const { data } = await sb.from('campaigns').select(FIELDS)
      .eq('tenant_id', tenant.id).eq('active', true)
      .lte('starts_at', now)
      .or(`ends_at.is.null,ends_at.gte.${now}`)
      .order('starts_at', { ascending: false });
    // Filter audience client-side: 'public' surface only sees public+both;
    // 'members' surface sees members+both
    const filtered = (data ?? []).filter(c => {
      if (c.audience === 'both') return true;
      return c.audience === wantAudience;
    });
    return jsonResponse({ ok: true, campaigns: filtered });
  }

  // Admin actions
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // Scope gate: this function's admin actions require the 'campaigns' scope.
  // Synthetic webhook tokens bypass; super + owner roles bypass.
  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(sb, payload as never, 'campaigns'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: campaigns' }, 403);
  }
  const TID = payload.tid;

  if (action === 'list') {
    const { data, error } = await sb.from('campaigns').select(FIELDS)
      .eq('tenant_id', TID)
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, campaigns: data ?? [] });
  }

  if (action === 'create') {
    const title = String(body.title ?? '').trim();
    if (!title) return jsonResponse({ ok: false, error: 'Title is required' }, 400);
    if (title.length > 140) return jsonResponse({ ok: false, error: 'Title too long' }, 400);
    const kind = String(body.kind ?? 'announcement');
    if (!VALID_KIND.has(kind)) return jsonResponse({ ok: false, error: 'Invalid kind' }, 400);
    const audience = String(body.audience ?? 'members');
    if (!VALID_AUDIENCE.has(audience)) return jsonResponse({ ok: false, error: 'Invalid audience' }, 400);

    const { data, error } = await sb.from('campaigns').insert({
      tenant_id: TID, title, kind, audience,
      body:       strOrNull(body.body),
      emoji:      strOrNull(body.emoji) ?? '📣',
      cta_label:  strOrNull(body.cta_label),
      cta_url:    strOrNull(body.cta_url),
      starts_at:  isoOrNull(body.starts_at) ?? new Date().toISOString(),
      ends_at:    isoOrNull(body.ends_at),
    }).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, campaign: data });
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
    if (body.body      !== undefined) patch.body      = strOrNull(body.body);
    if (body.emoji     !== undefined) patch.emoji     = strOrNull(body.emoji) ?? '📣';
    if (body.cta_label !== undefined) patch.cta_label = strOrNull(body.cta_label);
    if (body.cta_url   !== undefined) patch.cta_url   = strOrNull(body.cta_url);
    if (body.kind !== undefined) {
      const k = String(body.kind);
      if (!VALID_KIND.has(k)) return jsonResponse({ ok: false, error: 'Invalid kind' }, 400);
      patch.kind = k;
    }
    if (body.audience !== undefined) {
      const a = String(body.audience);
      if (!VALID_AUDIENCE.has(a)) return jsonResponse({ ok: false, error: 'Invalid audience' }, 400);
      patch.audience = a;
    }
    if (body.starts_at !== undefined) patch.starts_at = isoOrNull(body.starts_at) ?? new Date().toISOString();
    if (body.ends_at   !== undefined) patch.ends_at   = isoOrNull(body.ends_at);
    if (body.active    !== undefined) patch.active    = !!body.active;

    const { data, error } = await sb.from('campaigns').update(patch)
      .eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, campaign: data });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('campaigns')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

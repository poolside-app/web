// =============================================================================
// tenant_settings — Read/write the per-tenant settings JSONB
// =============================================================================
// Auth: tenant admin token (HS256, kind='tenant_admin'). Tenant scope is
// pulled from the token, never the body, so an admin can't write to another
// tenant's settings.
//
// Actions:
//
//   { action: 'get' }
//     → { ok, settings, tenant: { display_name, slug } }
//
//   { action: 'save', value, display_name? }
//     • value: JSON object (replaces settings.value)
//     • display_name: if provided, also updates tenants.display_name
//     → { ok }
//
//   { action: 'mark_wizard_complete' }
//     → { ok }   // shorthand for save with setup_wizard_complete=true
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

type Payload = { sub: string; kind: string; tid: string; slug: string };

async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin') return null;
    if (!payload.sub || !payload.tid || !payload.slug) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── get ────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const [{ data: settings }, { data: tenant }] = await Promise.all([
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
      sb.from('tenants').select('slug, display_name, status, plan').eq('id', payload.tid).maybeSingle(),
    ]);
    return jsonResponse({
      ok: true,
      settings: settings?.value ?? {},
      tenant: tenant ?? null,
    });
  }

  // ── save ───────────────────────────────────────────────────────────────
  if (action === 'save') {
    const value = (body.value ?? {}) as Record<string, unknown>;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return jsonResponse({ ok: false, error: '`value` must be a JSON object' }, 400);
    }

    // Upsert settings row. Shallow-merge with existing so a save from one
    // surface (wizard, settings page, members→tiers) doesn't clobber keys
    // managed by another. Top-level keys present in `value` win; any keys
    // only in the existing row (e.g. membership_tiers seeded at signup, or
    // saved from a different page) are preserved.
    const { data: existing } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    if (existing) {
      const merged = { ...(existing.value ?? {}), ...value } as Record<string, unknown>;
      const { error } = await sb.from('settings')
        .update({ value: merged }).eq('tenant_id', payload.tid);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    } else {
      const { error } = await sb.from('settings')
        .insert({ tenant_id: payload.tid, value });
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }

    // Optionally update the tenant display_name in lockstep with the wizard.
    if (typeof body.display_name === 'string') {
      const dn = body.display_name.trim();
      if (dn) {
        await sb.from('tenants').update({ display_name: dn }).eq('id', payload.tid);
      }
    }

    return jsonResponse({ ok: true });
  }

  // ── mark_wizard_complete ───────────────────────────────────────────────
  if (action === 'mark_wizard_complete') {
    const { data: existing } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    const value = { ...(existing?.value ?? {}), setup_wizard_complete: true };
    if (existing) {
      await sb.from('settings').update({ value }).eq('tenant_id', payload.tid);
    } else {
      await sb.from('settings').insert({ tenant_id: payload.tid, value });
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

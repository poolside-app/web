// =============================================================================
// tenants_admin — Provider-side tenant management
// =============================================================================
// Authenticated by provider-admin JWT (HS256 with ADMIN_JWT_SECRET, kind='provider').
// Uses service role for DB access (bypasses RLS).
//
// Actions:
//
//   { action: 'list' }
//     → { ok, tenants: [...] }
//
//   { action: 'create', slug, display_name, plan?, status? }
//     → { ok, tenant }
//
//   { action: 'update', id, ...patch }
//     → { ok, tenant }
//
//   { action: 'delete', id }   ← soft-delete (status = 'churned')
//     → { ok }
//
// All actions require Authorization: Bearer <provider-admin token>.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
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

async function verifyProviderToken(token: string): Promise<string | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as { sub?: string; kind?: string };
    if (payload.kind !== 'provider' || !payload.sub) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

const VALID_PLANS = ['free', 'starter', 'pro', 'enterprise'];
const VALID_STATUSES = ['trial', 'active', 'suspended', 'churned'];

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

// Same helper as in tenant_signup — adds <slug>.poolsideapp.com to the Vercel
// project. Best-effort; if Vercel hiccups, the tenant is still created.
async function addVercelSubdomain(slug: string): Promise<{ ok: boolean; error?: string }> {
  const token     = Deno.env.get('VERCEL_API_TOKEN');
  const projectId = Deno.env.get('VERCEL_PROJECT_ID');
  if (!token || !projectId) {
    return { ok: false, error: 'VERCEL_API_TOKEN or VERCEL_PROJECT_ID not set' };
  }
  const domain = `${slug}.poolsideapp.com`;
  try {
    const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/domains`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: domain }),
    });
    if (res.ok) return { ok: true };
    if (res.status === 409) return { ok: true };
    const txt = await res.text();
    console.warn(`[tenants_admin] Vercel domain add failed for ${domain}:`, res.status, txt);
    return { ok: false, error: `Vercel ${res.status}: ${txt.slice(0, 200)}` };
  } catch (e) {
    console.warn(`[tenants_admin] Vercel API error:`, e);
    return { ok: false, error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  // Verify token
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const adminId = token ? await verifyProviderToken(token) : null;
  if (!adminId) return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Confirm provider admin still active
  const { data: caller } = await sb.from('provider_admins')
    .select('id, active, is_super').eq('id', adminId).maybeSingle();
  if (!caller || !caller.active) {
    return jsonResponse({ ok: false, error: 'Provider admin not found or inactive' }, 401);
  }

  // ── list ───────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data, error } = await sb.from('tenants')
      .select('id, slug, display_name, custom_domain, status, plan, trial_ends_at, stripe_customer_id, notes, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Optional: enrich with member counts per tenant
    const ids = (data ?? []).map(t => t.id);
    let counts: Record<string, number> = {};
    if (ids.length) {
      const { data: countRows } = await sb.from('households')
        .select('tenant_id, id')
        .in('tenant_id', ids);
      counts = (countRows ?? []).reduce((acc, r) => {
        acc[r.tenant_id as string] = (acc[r.tenant_id as string] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
    }
    const enriched = (data ?? []).map(t => ({
      ...t,
      household_count: counts[t.id as string] || 0,
    }));
    return jsonResponse({ ok: true, tenants: enriched });
  }

  // ── create ─────────────────────────────────────────────────────────────
  if (action === 'create') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const display_name = String(body.display_name ?? '').trim();
    if (!slug) return jsonResponse({ ok: false, error: 'Slug is required' }, 400);
    if (!/^[a-z0-9][a-z0-9-]{1,29}$/.test(slug)) {
      return jsonResponse({ ok: false, error: 'Slug must be 2–30 chars, lowercase letters / numbers / hyphens, starting with a letter or number' }, 400);
    }
    if (!display_name) return jsonResponse({ ok: false, error: 'Display name is required' }, 400);

    const plan = strOrNull(body.plan) ?? 'free';
    if (!VALID_PLANS.includes(plan)) {
      return jsonResponse({ ok: false, error: `Plan must be one of: ${VALID_PLANS.join(', ')}` }, 400);
    }
    const status = strOrNull(body.status) ?? 'trial';
    if (!VALID_STATUSES.includes(status)) {
      return jsonResponse({ ok: false, error: `Status must be one of: ${VALID_STATUSES.join(', ')}` }, 400);
    }
    const notes = strOrNull(body.notes);

    const { data, error } = await sb.from('tenants').insert({
      slug, display_name, plan, status, notes,
    }).select().single();
    if (error) {
      if (error.message.includes('duplicate') || error.message.includes('unique')) {
        return jsonResponse({ ok: false, error: `Slug "${slug}" is already taken` }, 409);
      }
      return jsonResponse({ ok: false, error: error.message }, 500);
    }

    // Seed an empty settings row
    await sb.from('settings').insert({ tenant_id: data.id, value: {} });

    // Auto-provision the Vercel subdomain
    const vercel = await addVercelSubdomain(data.slug);

    return jsonResponse({
      ok: true,
      tenant: data,
      subdomain_provisioned: vercel.ok,
      subdomain_warning: vercel.ok ? null : vercel.error,
    });
  }

  // ── update ─────────────────────────────────────────────────────────────
  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const patch: Record<string, unknown> = {};
    if (body.display_name !== undefined) {
      const v = String(body.display_name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Display name cannot be empty' }, 400);
      patch.display_name = v;
    }
    if (body.plan !== undefined) {
      const v = String(body.plan).toLowerCase();
      if (!VALID_PLANS.includes(v)) {
        return jsonResponse({ ok: false, error: `Plan must be one of: ${VALID_PLANS.join(', ')}` }, 400);
      }
      patch.plan = v;
    }
    if (body.status !== undefined) {
      const v = String(body.status).toLowerCase();
      if (!VALID_STATUSES.includes(v)) {
        return jsonResponse({ ok: false, error: `Status must be one of: ${VALID_STATUSES.join(', ')}` }, 400);
      }
      patch.status = v;
    }
    if (body.custom_domain !== undefined) patch.custom_domain = strOrNull(body.custom_domain);
    if (body.notes !== undefined)         patch.notes         = strOrNull(body.notes);
    if (body.trial_ends_at !== undefined) patch.trial_ends_at = body.trial_ends_at;

    if (Object.keys(patch).length === 0) {
      return jsonResponse({ ok: true, noop: true });
    }

    const { data, error } = await sb.from('tenants').update(patch).eq('id', id).select().single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, tenant: data });
  }

  // ── list_admins ────────────────────────────────────────────────────────
  if (action === 'list_admins') {
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const { data, error } = await sb.from('admin_users')
      .select('id, email, username, display_name, is_super, is_default_pw, active, created_at')
      .eq('tenant_id', tenant_id)
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, admins: data ?? [] });
  }

  // ── create_admin ───────────────────────────────────────────────────────
  // Provider creates the first (or an additional) tenant admin. Sets
  // is_default_pw=true so the new admin is forced to change the password
  // on first login.
  if (action === 'create_admin') {
    const tenant_id    = String(body.tenant_id ?? '');
    const email        = String(body.email ?? '').trim().toLowerCase();
    const password     = String(body.password ?? '');
    const display_name = strOrNull(body.display_name) ?? (email ? email.split('@')[0] : null);
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    if (!email || !email.includes('@') || email.length > 200) {
      return jsonResponse({ ok: false, error: 'Valid email is required' }, 400);
    }
    if (!password || password.length < 10) {
      return jsonResponse({ ok: false, error: 'Password must be at least 10 characters' }, 400);
    }

    const { data: tenant } = await sb.from('tenants')
      .select('id').eq('id', tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

    const { data: clash } = await sb.from('admin_users')
      .select('id').eq('tenant_id', tenant_id)
      .or(`email.eq.${email},username.eq.${email}`).maybeSingle();
    if (clash) return jsonResponse({ ok: false, error: 'An admin with that email already exists for this tenant' }, 409);

    const password_hash = await bcrypt.hash(password, 10);
    const { data: admin, error: aErr } = await sb.from('admin_users').insert({
      tenant_id, username: email, email, password_hash, display_name,
      is_super: true, is_default_pw: true, active: true,
    }).select('id, email, display_name').single();
    if (aErr || !admin) return jsonResponse({ ok: false, error: aErr?.message || 'Could not create admin' }, 500);

    // Assign the system 'super-admin' role if it exists (best-effort).
    const { data: superRole } = await sb.from('admin_roles')
      .select('id').eq('slug', 'super-admin').is('tenant_id', null).maybeSingle();
    if (superRole) {
      await sb.from('admin_user_roles').insert({
        admin_user_id: admin.id, admin_role_id: superRole.id,
      });
    }
    return jsonResponse({ ok: true, admin });
  }

  // ── delete (soft) ──────────────────────────────────────────────────────
  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('tenants')
      .update({ status: 'churned' }).eq('id', id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

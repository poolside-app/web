// =============================================================================
// tenant_admin_auth — Per-tenant admin login
// =============================================================================
// Counterpart to admin_auth (which is provider-only). Authenticates against
// admin_users scoped to a tenant, identified by the slug carried with the
// request. JWTs signed with the same ADMIN_JWT_SECRET but with
// kind='tenant_admin' so the two surfaces stay distinct.
//
// Actions:
//
//   { action: 'login', slug, email, password }
//     → { ok, token, user: { id, email, display_name, is_super, is_default_pw }, tenant: { slug, display_name } }
//
//   { action: 'me' }                    [requires Authorization: Bearer <token>]
//     → { ok, user, tenant }
//
//   { action: 'change_password', current_password, new_password }
//                                       [requires Authorization]
//     → { ok }
//
//   { action: 'logout' }                — client just drops the token; server is stateless
//     → { ok }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { create, verify, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

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

async function getJwtKey(): Promise<CryptoKey> {
  if (!JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

type TenantAdminPayload = {
  sub: string; kind: 'tenant_admin'; tid: string; slug: string; exp: number;
  impersonated_by?: string; synthetic?: boolean;
};

async function signToken(adminUserId: string, tenantId: string, slug: string): Promise<string> {
  const key = await getJwtKey();
  return await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      sub: adminUserId,
      kind: 'tenant_admin',
      tid: tenantId,
      slug,
      exp: getNumericDate(60 * 60 * 24 * 30),  // 30 days
    },
    key,
  );
}

async function verifyToken(token: string): Promise<TenantAdminPayload | null> {
  try {
    const key = await getJwtKey();
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin') return null;
    if (!payload.sub || !payload.tid || !payload.slug) return null;
    return payload as unknown as TenantAdminPayload;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── login ──────────────────────────────────────────────────────────────
  if (action === 'login') {
    const slug     = String(body.slug ?? '').trim().toLowerCase();
    const email    = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!slug || !email || !password) {
      return jsonResponse({ ok: false, error: 'slug, email, and password are required' }, 400);
    }

    // Find tenant
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, status')
      .eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401);
    if (tenant.status === 'churned') {
      return jsonResponse({ ok: false, error: 'This club is no longer active' }, 403);
    }

    // Find the admin user inside that tenant. Match on either email or
    // username so people can log in with whatever they typed at signup.
    const { data: user } = await sb.from('admin_users')
      .select('id, email, username, display_name, password_hash, is_super, is_default_pw, active')
      .eq('tenant_id', tenant.id)
      .or(`email.eq.${email},username.eq.${email}`)
      .maybeSingle();
    if (!user || !user.active) {
      return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401);
    }

    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401);

    const token = await signToken(user.id, tenant.id, tenant.slug);
    return jsonResponse({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_super: user.is_super,
        is_default_pw: user.is_default_pw,
      },
      tenant: {
        slug: tenant.slug,
        display_name: tenant.display_name,
        status: tenant.status,
      },
    });
  }

  // Auth required for everything below
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyToken(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);

  // ── me ─────────────────────────────────────────────────────────────────
  if (action === 'me') {
    const [{ data: user }, { data: tenant }, { data: settings }] = await Promise.all([
      sb.from('admin_users')
        .select('id, email, display_name, is_super, is_default_pw, active')
        .eq('id', payload.sub).maybeSingle(),
      sb.from('tenants')
        .select('slug, display_name, status, plan')
        .eq('id', payload.tid).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
    ]);
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 401);
    const features = ((settings?.value ?? {}) as Record<string, unknown>).features ?? {};

    // Synthetic impersonation tokens have no real admin_users row — fall
    // back to a synthetic user identity sourced from the JWT itself.
    if ((!user || !user.active) && payload.synthetic) {
      return jsonResponse({
        ok: true,
        tenant: { ...tenant, features },
        user: {
          id: payload.sub,
          email: 'provider@poolsideapp.com',
          display_name: 'Provider (impersonating)',
          is_super: true,
          is_default_pw: false,
          impersonated: true,
        },
      });
    }
    if (!user || !user.active) return jsonResponse({ ok: false, error: 'User not found' }, 401);

    return jsonResponse({
      ok: true,
      tenant: { ...tenant, features },
      user: { ...user, impersonated: !!payload.impersonated_by },
    });
  }

  // ── change_password ────────────────────────────────────────────────────
  if (action === 'change_password') {
    if (payload.impersonated_by) {
      return jsonResponse({ ok: false, error: 'Cannot change password while impersonating' }, 403);
    }
    const cur = String(body.current_password ?? '');
    const nxt = String(body.new_password ?? '');
    if (!cur || !nxt) return jsonResponse({ ok: false, error: 'Both passwords are required' }, 400);
    if (nxt.length < 10) return jsonResponse({ ok: false, error: 'New password must be at least 10 characters' }, 400);

    const { data: user } = await sb.from('admin_users')
      .select('id, password_hash').eq('id', payload.sub).maybeSingle();
    if (!user) return jsonResponse({ ok: false, error: 'User not found' }, 401);

    const ok = await bcrypt.compare(cur, user.password_hash || '');
    if (!ok) return jsonResponse({ ok: false, error: 'Current password is incorrect' }, 401);

    const hash = await bcrypt.hash(nxt, 10);
    const { error } = await sb.from('admin_users')
      .update({ password_hash: hash, is_default_pw: false })
      .eq('id', payload.sub);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  // ── logout ─────────────────────────────────────────────────────────────
  if (action === 'logout') {
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

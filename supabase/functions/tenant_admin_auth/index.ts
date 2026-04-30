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

// Predefined role templates. The `owner` template is special — it skips
// scope checks entirely (used for the original signup admin + super-users).
// Customize a template by editing scopes after assignment; role_template
// flips to 'custom' the moment the resolved scopes diverge from the
// template's canonical set.
const ROLE_TEMPLATES: Record<string, { label: string; scopes: string[] }> = {
  owner: {
    label: 'Owner / President',
    scopes: [],   // sentinel: empty + owner template = full access
  },
  treasurer: {
    label: 'Treasurer',
    scopes: ['payments', 'applications', 'audit', 'impact'],
  },
  membership: {
    label: 'Membership Chair',
    scopes: ['applications', 'households', 'directory', 'documents', 'impact'],
  },
  events: {
    label: 'Events / Programs',
    scopes: ['events', 'parties', 'programs', 'volunteer', 'passes', 'impact'],
  },
  communications: {
    label: 'Communications / Marketing',
    scopes: ['announcements', 'campaigns', 'photos', 'documents', 'policies', 'impact'],
  },
  custom: {
    label: 'Custom',
    scopes: [],
  },
};

const ALL_SCOPES = [
  'applications', 'households', 'payments', 'events', 'programs', 'parties',
  'announcements', 'campaigns', 'volunteer', 'passes', 'photos', 'documents',
  'policies', 'directory', 'impact', 'audit',
];

function templateScopes(name: string): string[] {
  const tpl = ROLE_TEMPLATES[name];
  return tpl ? [...tpl.scopes] : [];
}
function sanitizeScopes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const valid = new Set(ALL_SCOPES);
  return [...new Set(input.map(String).filter(s => valid.has(s)))];
}

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
      .select('id, email, username, display_name, password_hash, is_super, is_default_pw, active, scopes, role_template, phone_e164')
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
        role_template: user.role_template ?? 'owner',
        scopes: user.scopes ?? [],
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
        .select('id, email, display_name, is_super, is_default_pw, active, scopes, role_template, phone_e164')
        .eq('id', payload.sub).maybeSingle(),
      sb.from('tenants')
        .select('slug, display_name, status, plan')
        .eq('id', payload.tid).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
    ]);
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 401);
    const settingsValue = (settings?.value ?? {}) as Record<string, unknown>;
    const features = settingsValue.features ?? {};
    const branding = settingsValue.branding ?? {};

    // Synthetic impersonation tokens have no real admin_users row — fall
    // back to a synthetic user identity sourced from the JWT itself.
    if ((!user || !user.active) && payload.synthetic) {
      return jsonResponse({
        ok: true,
        tenant: { ...tenant, features, branding },
        user: {
          id: payload.sub,
          email: 'provider@poolsideapp.com',
          display_name: 'Provider (impersonating)',
          is_super: true,
          is_default_pw: false,
          impersonated: true,
          role_template: 'owner',
          scopes: [],
        },
      });
    }
    if (!user || !user.active) return jsonResponse({ ok: false, error: 'User not found' }, 401);

    return jsonResponse({
      ok: true,
      tenant: { ...tenant, features, branding },
      user: {
        ...user,
        scopes: user.scopes ?? [],
        role_template: user.role_template ?? 'owner',
        impersonated: !!payload.impersonated_by,
      },
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

  // ── Co-admin management ────────────────────────────────────────────────
  // Volunteer boards rotate. The first admin (from tenant_signup) needs to
  // grant access to the treasurer + secretary + president without dragging
  // Doug in. Anyone with an active admin_users row can manage their peers
  // — board self-governance, no super-admin tier required.

  if (action === 'list_admins') {
    const { data, error } = await sb.from('admin_users')
      .select('id, username, email, display_name, notify_pref, is_default_pw, is_super, active, last_login_at, created_at, scopes, role_template, phone_e164')
      .eq('tenant_id', payload.tid)
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, admins: data ?? [] });
  }

  if (action === 'list_role_templates') {
    return jsonResponse({
      ok: true,
      templates: Object.entries(ROLE_TEMPLATES)
        .filter(([k]) => k !== 'custom')
        .map(([key, t]) => ({ key, label: t.label, scopes: t.scopes })),
      all_scopes: ALL_SCOPES,
    });
  }

  if (action === 'invite_admin') {
    const usernameRaw = String(body.username ?? '').trim().toLowerCase();
    const email       = String(body.email ?? '').trim().toLowerCase();
    const display_name = String(body.display_name ?? '').trim();
    const phone_raw    = String(body.phone_e164 ?? '').trim();
    const username = usernameRaw || email;
    if (!username || !username.includes('@')) {
      return jsonResponse({ ok: false, error: 'Email-shaped username is required' }, 400);
    }
    if (!display_name) return jsonResponse({ ok: false, error: 'Name is required' }, 400);

    // Resolve role template + scopes. If caller passes scopes, those win
    // (template flips to 'custom'). Otherwise we use the named template's set.
    const requestedTemplate = String(body.role_template ?? 'membership').toLowerCase();
    const knownTemplate = ROLE_TEMPLATES[requestedTemplate] ? requestedTemplate : 'membership';
    let scopes = templateScopes(knownTemplate);
    let role_template = knownTemplate;
    if (body.scopes !== undefined) {
      const customScopes = sanitizeScopes(body.scopes);
      const matchesTemplate = customScopes.length === scopes.length &&
        customScopes.every(s => scopes.includes(s));
      if (!matchesTemplate) {
        scopes = customScopes;
        role_template = 'custom';
      }
    }
    // Phone normalization (best-effort; reject obvious garbage but keep it permissive)
    let phone: string | null = null;
    if (phone_raw) {
      const digits = phone_raw.replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) phone = digits;
      else if (/^\d{10}$/.test(digits)) phone = '+1' + digits;
      else if (/^1\d{10}$/.test(digits)) phone = '+' + digits;
      else return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    }

    // Make sure they don't already exist on this tenant
    const { data: clash } = await sb.from('admin_users').select('id, active')
      .eq('tenant_id', payload.tid).eq('username', username).maybeSingle();
    if (clash) {
      if (clash.active) return jsonResponse({ ok: false, error: 'That admin already exists' }, 409);
      // Reactivate stale row + apply the new role
      await sb.from('admin_users').update({
        active: true, display_name,
        email: email || username,
        scopes, role_template,
        phone_e164: phone ?? null,
      }).eq('id', clash.id);
      return jsonResponse({ ok: true, admin_id: clash.id, reactivated: true, role_template, scopes });
    }

    // Generate a temporary password — admin must change on first login.
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const tempPw = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
    const hash = await bcrypt.hash(tempPw, 10);

    const { data, error } = await sb.from('admin_users').insert({
      tenant_id: payload.tid,
      username, email: email || username, display_name,
      password_hash: hash,
      notify_pref: 'email',
      is_default_pw: true, active: true,
      scopes, role_template, phone_e164: phone,
    }).select('id, username, display_name, email').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.invited', entity_type: 'admin_user', entity_id: data.id,
        summary: `Invited ${display_name} (${username}) as ${ROLE_TEMPLATES[role_template]?.label ?? role_template}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* ignore */ }

    // Hand the temp password back to the caller so the inviting admin can
    // share it directly. When Resend wires up, this becomes an email + magic
    // link; when Twilio wires up, an SMS arrives if phone_e164 is set.
    return jsonResponse({ ok: true, admin_id: data.id, temp_password: tempPw, role_template, scopes });
  }

  if (action === 'update_admin_role') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: target } = await sb.from('admin_users')
      .select('id, tenant_id, role_template')
      .eq('id', id).maybeSingle();
    if (!target || target.tenant_id !== payload.tid) {
      return jsonResponse({ ok: false, error: 'Admin not found' }, 404);
    }

    // Refuse to demote the last owner — would lock the tenant out of admin
    // management forever. (Other owners exist? Then it's safe.)
    if (target.role_template === 'owner') {
      const { count } = await sb.from('admin_users').select('id', { count: 'exact', head: true })
        .eq('tenant_id', payload.tid).eq('active', true).eq('role_template', 'owner');
      if ((count ?? 0) <= 1) {
        return jsonResponse({ ok: false, error: 'At least one Owner must remain. Promote someone else first.' }, 400);
      }
    }

    const requestedTemplate = String(body.role_template ?? 'membership').toLowerCase();
    const knownTemplate = ROLE_TEMPLATES[requestedTemplate] ? requestedTemplate : 'membership';
    let scopes = templateScopes(knownTemplate);
    let role_template = knownTemplate;
    if (body.scopes !== undefined) {
      const customScopes = sanitizeScopes(body.scopes);
      const matchesTemplate = customScopes.length === scopes.length &&
        customScopes.every(s => scopes.includes(s));
      if (!matchesTemplate) {
        scopes = customScopes;
        role_template = 'custom';
      }
    }

    const { error } = await sb.from('admin_users').update({ scopes, role_template })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.role_changed', entity_type: 'admin_user', entity_id: id,
        summary: `Changed role to ${ROLE_TEMPLATES[role_template]?.label ?? role_template}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
        metadata: { scopes, role_template },
      });
    } catch { /* ignore */ }

    return jsonResponse({ ok: true, role_template, scopes });
  }

  if (action === 'deactivate_admin') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    if (id === payload.sub) return jsonResponse({ ok: false, error: 'Can\'t deactivate yourself' }, 400);
    // Don't strand the tenant — refuse if this is the last active admin
    const { count } = await sb.from('admin_users').select('id', { count: 'exact', head: true })
      .eq('tenant_id', payload.tid).eq('active', true);
    if ((count ?? 0) <= 1) {
      return jsonResponse({ ok: false, error: 'At least one admin must remain active' }, 400);
    }
    const { error } = await sb.from('admin_users').update({ active: false })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.deactivated', entity_type: 'admin_user', entity_id: id,
        summary: 'Co-admin deactivated', actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* ignore */ }
    return jsonResponse({ ok: true });
  }

  if (action === 'reset_admin_password') {
    // Reset a peer's password — generates a fresh temp, returns it to caller
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: target } = await sb.from('admin_users').select('id, tenant_id, active')
      .eq('id', id).maybeSingle();
    if (!target || target.tenant_id !== payload.tid) return jsonResponse({ ok: false, error: 'Admin not found' }, 404);
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const tempPw = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
    const hash = await bcrypt.hash(tempPw, 10);
    const { error } = await sb.from('admin_users')
      .update({ password_hash: hash, is_default_pw: true })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, temp_password: tempPw });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

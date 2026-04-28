// =============================================================================
// admin_auth — Provider admin authentication
// =============================================================================
// Authenticates Poolside provider admins (you, Doug, eventually small team).
// Distinct from per-tenant admin auth (different table, no tenant_id concept,
// cross-tenant powers).
//
// Action-routed body. Actions:
//
//   { action: 'login', username, password }
//     → { ok, token, user } on success
//     → { ok: false, error: 'Invalid credentials' } on failure (401)
//
//   { action: 'me' }                      [Authorization: Bearer <token>]
//     → { ok, user }
//
//   { action: 'change_password', current_password, new_password }
//   [Authorization]
//     → { ok }
//
//   { action: 'logout' }
//     → { ok }   (stateless tokens, just signals client to clear)
//
// JWT shape: HS256 signed with ADMIN_JWT_SECRET. Claims:
//   - sub: provider_admin.id
//   - kind: 'provider'
//   - exp: 30 days
//
// Required env (Supabase auto-injected for first two; we set the third):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_JWT_SECRET
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
    'raw',
    new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

async function signToken(providerAdminId: string): Promise<string> {
  const key = await getJwtKey();
  return await create(
    { alg: 'HS256', typ: 'JWT' },
    { sub: providerAdminId, kind: 'provider', exp: getNumericDate(60 * 60 * 24 * 30) },
    key,
  );
}

async function verifyToken(token: string): Promise<string | null> {
  try {
    const key = await getJwtKey();
    const payload = await verify(token, key) as { sub?: string; kind?: string };
    if (payload.kind !== 'provider') return null;
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

async function loadAdminShape(sb: ReturnType<typeof createClient>, adminId: string) {
  const { data: admin } = await sb.from('provider_admins')
    .select('id, email, display_name, is_super, is_default_pw, active, last_login_at, created_at')
    .eq('id', adminId)
    .maybeSingle();
  if (!admin || !admin.active) return null;
  return {
    id: admin.id,
    email: admin.email,
    display_name: admin.display_name,
    is_super: admin.is_super,
    is_default_pw: admin.is_default_pw,
    last_login_at: admin.last_login_at,
    created_at: admin.created_at,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  if (!JWT_SECRET) {
    return jsonResponse({ ok: false, error: 'Server missing ADMIN_JWT_SECRET' }, 500);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── login ──────────────────────────────────────────────────────────────
  if (action === 'login') {
    const email = String(body.username ?? body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!email || !password) {
      return jsonResponse({ ok: false, error: 'Email + password required' });
    }

    const { data: admin } = await sb.from('provider_admins')
      .select('id, email, password_hash, active, is_default_pw, display_name, is_super')
      .eq('email', email)
      .maybeSingle();

    if (!admin || !admin.active) {
      // Generic message — don't leak whether the email exists
      return jsonResponse({ ok: false, error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return jsonResponse({ ok: false, error: 'Invalid credentials' });
    }

    // Stamp last_login, fire and forget
    await sb.from('provider_admins')
      .update({ last_login_at: new Date().toISOString() })
      .eq('id', admin.id);

    const token = await signToken(admin.id);
    const shape = await loadAdminShape(sb, admin.id);
    return jsonResponse({ ok: true, token, user: shape });
  }

  // ── me ─────────────────────────────────────────────────────────────────
  // Returns the current provider admin's shape based on the bearer token.
  if (action === 'me') {
    const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
    const adminId = token ? await verifyToken(token) : null;
    if (!adminId) {
      return jsonResponse({ ok: false, error: 'Invalid or expired session' });
    }
    const shape = await loadAdminShape(sb, adminId);
    if (!shape) {
      return jsonResponse({ ok: false, error: 'User not found or inactive' });
    }
    return jsonResponse({ ok: true, user: shape });
  }

  // ── change_password ────────────────────────────────────────────────────
  if (action === 'change_password') {
    const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
    const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
    const adminId = token ? await verifyToken(token) : null;
    if (!adminId) {
      return jsonResponse({ ok: false, error: 'Invalid or expired session' });
    }

    const current = String(body.current_password ?? '');
    const next    = String(body.new_password ?? '');
    if (!current || !next) {
      return jsonResponse({ ok: false, error: 'Both current and new password required' });
    }
    if (next.length < 10) {
      return jsonResponse({ ok: false, error: 'New password must be at least 10 characters' });
    }
    if (current === next) {
      return jsonResponse({ ok: false, error: "New password can't match current password" });
    }

    const { data: admin } = await sb.from('provider_admins')
      .select('id, password_hash')
      .eq('id', adminId)
      .maybeSingle();
    if (!admin) {
      return jsonResponse({ ok: false, error: 'User not found' });
    }

    const valid = await bcrypt.compare(current, admin.password_hash);
    if (!valid) {
      return jsonResponse({ ok: false, error: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(next, 10);
    const { error: updErr } = await sb.from('provider_admins')
      .update({ password_hash: newHash, is_default_pw: false })
      .eq('id', adminId);
    if (updErr) {
      return jsonResponse({ ok: false, error: updErr.message }, 500);
    }
    return jsonResponse({ ok: true });
  }

  // ── logout ─────────────────────────────────────────────────────────────
  // Tokens are stateless. Logout is a client-side concern (clear localStorage).
  // We just acknowledge so the client UI can flow through.
  if (action === 'logout') {
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

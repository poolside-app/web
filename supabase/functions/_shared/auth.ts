// =============================================================================
// auth.ts — JWT verification + scope/role gates for admin functions
// =============================================================================
// Single source of truth for "is this caller allowed to do X?". Every
// admin-side edge function should:
//
//   import { verifyTenantAdmin, requireScope, requireOwner } from '../_shared/auth.ts';
//
//   const payload = await verifyTenantAdmin(req);
//   if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
//
//   const allowed = await requireScope(sb, payload, 'applications');
//   if (!allowed) return jsonResponse({ ok: false, error: 'Missing applications scope' }, 403);
//
// Role rules:
//   - super (is_super)         → bypasses all checks (Doug + future support staff)
//   - owner (role_template='owner') → bypasses scope checks (full club access)
//   - scoped admin             → must have the named scope in `scopes[]`
//   - inactive admin           → blocked regardless of role/scopes
//
// JWT-first, DB-fallback: tokens issued before the role/scope claims existed
// fall through to a DB lookup so old sessions don't break on deploy. The DB
// is also the source of truth for revocation — a deactivated admin's tokens
// stop working on the next call (no need to invalidate the JWT).
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const JWT_SECRET = Deno.env.get('ADMIN_JWT_SECRET');

export type AdminPayload = {
  sub: string;                       // admin_users.id
  kind: string;                      // 'tenant_admin'
  tid: string;                       // tenant_id
  slug?: string;
  role_template?: string;            // 'owner' | 'treasurer' | 'membership' | etc.
  scopes?: string[];
  is_super?: boolean;
  synthetic?: boolean;               // service-to-service (e.g. webhook auto-approve)
  exp?: number;
};

let cachedKey: CryptoKey | null = null;
async function getKey(): Promise<CryptoKey> {
  if (cachedKey) return cachedKey;
  if (!JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
  cachedKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
  return cachedKey;
}

// Extract Bearer token from request, verify signature + tenant_admin kind.
// Returns null on any failure — callers should respond 401.
export async function verifyTenantAdmin(req: Request): Promise<AdminPayload | null> {
  if (!JWT_SECRET) return null;
  const hdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
  if (!tok) return null;
  try {
    const key = await getKey();
    const p = await verify(tok, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as AdminPayload;
  } catch { return null; }
}

// Resolve the caller's effective role + scopes. JWT first; falls back to DB
// if the token predates the role/scope claims (graceful upgrade for old
// sessions). DB is also authoritative on `active` — a deactivated admin's
// token stops working on the next call.
async function resolveRole(
  sb: SupabaseClient,
  payload: AdminPayload,
): Promise<{ active: boolean; isSuper: boolean; isOwner: boolean; scopes: string[] }> {
  // Synthetic service tokens (e.g. webhook auto-approve) get full access.
  if (payload.synthetic) return { active: true, isSuper: true, isOwner: true, scopes: [] };

  // JWT-resolved fields override DB if present
  const jwtComplete = payload.role_template !== undefined && payload.scopes !== undefined;
  if (jwtComplete) {
    // Still need to check `active` — JWT can't carry that safely (would
    // need rotation on deactivate). Quick targeted query.
    const { data: row } = await sb.from('admin_users')
      .select('active').eq('id', payload.sub).maybeSingle();
    if (!row || !row.active) return { active: false, isSuper: false, isOwner: false, scopes: [] };
    return {
      active: true,
      isSuper: !!payload.is_super,
      isOwner: payload.role_template === 'owner',
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
    };
  }

  const { data: admin } = await sb.from('admin_users')
    .select('role_template, scopes, is_super, active')
    .eq('id', payload.sub).eq('tenant_id', payload.tid).maybeSingle();
  if (!admin || !admin.active) return { active: false, isSuper: false, isOwner: false, scopes: [] };
  return {
    active: true,
    isSuper: !!admin.is_super,
    isOwner: (admin.role_template ?? 'owner') === 'owner',
    scopes: (admin.scopes as string[] | null) ?? [],
  };
}

// True if super or owner. Use for tenant-config actions that should never
// be delegated to scoped admins (Stripe Connect, admin invite, etc.).
export async function requireOwner(sb: SupabaseClient, payload: AdminPayload): Promise<boolean> {
  const r = await resolveRole(sb, payload);
  return r.active && (r.isSuper || r.isOwner);
}

// True if super, owner, or holds the named scope.
export async function requireScope(
  sb: SupabaseClient,
  payload: AdminPayload,
  scope: string,
): Promise<boolean> {
  const r = await resolveRole(sb, payload);
  if (!r.active) return false;
  if (r.isSuper || r.isOwner) return true;
  return r.scopes.includes(scope);
}

// True if super only (Doug + future Anthropic-side support staff).
export async function requireSuper(sb: SupabaseClient, payload: AdminPayload): Promise<boolean> {
  const r = await resolveRole(sb, payload);
  return r.active && r.isSuper;
}

// Standard 403 body shape for callers that want to surface "missing X scope".
export function scopeError(scope: string): { ok: false; error: string } {
  return { ok: false, error: `Missing required scope: ${scope}` };
}

// =============================================================================
// admin_tasks — board-member task queue, scoped by role
// =============================================================================
// When a member submits an application or claims a Venmo payment, the
// system writes a task here. Anyone with a matching scope (or owner role)
// sees it on their dashboard. First admin to handle it closes it for
// everyone — no double-handling.
//
// Actions:
//   { action: 'list', include_completed? }
//     → { ok, tasks: [...] }   — open tasks visible to caller, newest first
//
//   { action: 'count' }
//     → { ok, open: N }        — fast pill for the dashboard
//
//   { action: 'complete', id, note? }
//     → { ok }
//
//   { action: 'dismiss', id }
//     → { ok }
//
// Tasks are also created by other Edge Functions (applications, parties,
// etc.). They share a helper: `enqueueTask(...)` in those functions writes
// directly to admin_tasks via service-role client.
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
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const FIELDS = 'id, tenant_id, target_scopes, kind, summary, link_url, source_kind, source_id, metadata, created_at, completed_at, completed_by, dismissed_at';

// Returns the caller's effective scopes + owner flag, sourced from the DB
// rather than the JWT (so role changes take effect immediately on next call).
async function getCallerScope(sb: ReturnType<typeof createClient>, payload: Payload): Promise<{ isOwner: boolean; scopes: string[] }> {
  if (payload.synthetic) return { isOwner: true, scopes: [] };
  const { data: user } = await sb.from('admin_users')
    .select('role_template, scopes, active')
    .eq('id', payload.sub).eq('tenant_id', payload.tid).maybeSingle();
  if (!user || !user.active) return { isOwner: false, scopes: [] };
  return {
    isOwner: (user.role_template ?? 'owner') === 'owner',
    scopes: (user.scopes ?? []) as string[],
  };
}

function visibleToCaller(task: Record<string, unknown>, isOwner: boolean, callerScopes: string[]): boolean {
  if (isOwner) return true;
  const targets = (task.target_scopes ?? []) as string[];
  if (!targets.length) return false;     // empty = owners only
  return targets.some(s => callerScopes.includes(s));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyTenantAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { isOwner, scopes } = await getCallerScope(sb, payload);

  if (action === 'list') {
    let q = sb.from('admin_tasks').select(FIELDS).eq('tenant_id', TID);
    if (!body.include_completed) {
      q = q.is('completed_at', null).is('dismissed_at', null);
    }
    q = q.order('created_at', { ascending: false }).limit(100);
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const tasks = (data ?? []).filter(t => visibleToCaller(t, isOwner, scopes));
    return jsonResponse({ ok: true, tasks });
  }

  if (action === 'count') {
    const { data, error } = await sb.from('admin_tasks').select('id, target_scopes')
      .eq('tenant_id', TID).is('completed_at', null).is('dismissed_at', null);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const open = (data ?? []).filter(t => visibleToCaller(t, isOwner, scopes)).length;
    return jsonResponse({ ok: true, open });
  }

  if (action === 'complete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: task } = await sb.from('admin_tasks').select('id, target_scopes, completed_at')
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!task) return jsonResponse({ ok: false, error: 'Task not found' }, 404);
    if (!visibleToCaller(task as Record<string, unknown>, isOwner, scopes)) {
      return jsonResponse({ ok: false, error: 'Not your scope' }, 403);
    }
    if (task.completed_at) return jsonResponse({ ok: true });
    const { error } = await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: payload.synthetic ? null : payload.sub })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'dismiss') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: task } = await sb.from('admin_tasks').select('id, target_scopes, dismissed_at')
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!task) return jsonResponse({ ok: false, error: 'Task not found' }, 404);
    if (!visibleToCaller(task as Record<string, unknown>, isOwner, scopes)) {
      return jsonResponse({ ok: false, error: 'Not your scope' }, 403);
    }
    if (task.dismissed_at) return jsonResponse({ ok: true });
    const { error } = await sb.from('admin_tasks')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

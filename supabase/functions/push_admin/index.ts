// =============================================================================
// push_admin — Web Push subscriptions + sends for admin PWA notifications
// =============================================================================
// Lets board members opt in to push notifications on their phone PWA. Only
// fires for action-needed events (new application, Venmo claim awaiting
// verify, etc.) — not chatty stuff. Stripe payments don't push because
// they're auto-handled.
//
// Public actions (admin-auth):
//   { action: 'vapid_public_key' }
//     → { ok, key }   — base64url VAPID public key for browser subscribe()
//
//   { action: 'subscribe', endpoint, p256dh, auth, user_agent? }
//     → { ok, id }    — saves the browser's push subscription
//
//   { action: 'unsubscribe', endpoint }
//     → { ok }
//
//   { action: 'list' }
//     → { ok, subscriptions: [{ id, endpoint, user_agent, created_at }] }
//
//   { action: 'test' }
//     → { ok, sent, failed }   — fires a "PWA notifications enabled" push
//                                to all of the caller's own subscriptions
//
// Internal action (service-role only, x-poolside-internal header):
//   { action: 'send_scoped', tenant_id, scopes, title, body, url?, tag? }
//     → { ok, sent, failed }
//     Fans out to every admin in tenant_id whose role includes ANY of
//     `scopes` (or whose role_template === 'owner'). Used by other edge
//     functions when an admin_tasks row is inserted.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

// VAPID keys — generate once via `npx web-push generate-vapid-keys` and
// paste into env. push_admin returns a friendly error if they're missing
// rather than 500'ing in Resend / SW logs.
const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:doug@poolsideapp.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-poolside-internal',
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

type WebPushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

// Fire one push, return whether it succeeded. On 404/410 (Mozilla/Apple/FCM
// "subscription gone") delete the row so we don't keep retrying dead endpoints.
async function sendOne(
  sb: ReturnType<typeof createClient>,
  row: { id: string; endpoint: string; p256dh: string; auth: string },
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const sub: WebPushSubscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  };
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), {
      TTL: 60 * 60 * 24,                     // give push services 24h
      urgency: 'high' as const,              // user is waiting on this
    });
    return { ok: true };
  } catch (e: unknown) {
    const err = e as { statusCode?: number; body?: string; message?: string };
    const status = err?.statusCode ?? 0;
    if (status === 404 || status === 410) {
      // Endpoint is dead — clean up.
      await sb.from('admin_push_subscriptions').delete().eq('id', row.id);
    }
    return { ok: false, status, error: err?.body || err?.message || 'send failed' };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')   return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── send_scoped (service-role only) ────────────────────────────────────
  // Fan-out send used by other edge functions when something needs board
  // attention. Auth: require x-poolside-internal === SERVICE_ROLE so only
  // server-to-server callers can fire this (never the browser).
  if (action === 'send_scoped') {
    const internalKey = req.headers.get('x-poolside-internal') || '';
    if (internalKey !== SERVICE_ROLE) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return jsonResponse({ ok: false, error: 'VAPID keys not configured', skipped: true });
    }
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : [];
    if (scopes.length === 0) return jsonResponse({ ok: false, error: 'scopes required' }, 400);
    const title = String(body.title || 'Action needed');
    body.body  = String(body.body  || '');
    const url   = body.url ? String(body.url) : '/club/admin/';
    const tag   = body.tag ? String(body.tag) : 'poolside-action';

    // Find admins matching ANY scope (or owner-role).
    const { data: admins } = await sb.from('admin_users')
      .select('id, role_template, scopes, active')
      .eq('tenant_id', tenant_id).eq('active', true);
    const targetAdminIds = (admins ?? [])
      .filter(a => {
        if ((a.role_template ?? 'owner') === 'owner') return true;
        const userScopes = (a.scopes ?? []) as string[];
        return scopes.some(s => userScopes.includes(s));
      })
      .map(a => a.id);

    if (targetAdminIds.length === 0) {
      return jsonResponse({ ok: true, sent: 0, failed: 0, no_targets: true });
    }

    const { data: subs } = await sb.from('admin_push_subscriptions')
      .select('id, endpoint, p256dh, auth, admin_user_id')
      .eq('tenant_id', tenant_id)
      .in('admin_user_id', targetAdminIds);
    if (!subs || subs.length === 0) {
      return jsonResponse({ ok: true, sent: 0, failed: 0, no_subscribers: true });
    }

    let sent = 0, failed = 0;
    await Promise.all(subs.map(async (s) => {
      const r = await sendOne(sb, s as never, {
        title, body: body.body, url, tag,
        icon: '/icon-192.png', badge: '/icon-192.png',
      });
      if (r.ok) sent++; else failed++;
    }));

    return jsonResponse({ ok: true, sent, failed });
  }

  // ── Everything else requires admin auth ────────────────────────────────
  const authHdr = req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  // ── vapid_public_key ───────────────────────────────────────────────────
  if (action === 'vapid_public_key') {
    if (!VAPID_PUBLIC) {
      return jsonResponse({ ok: false, error: 'Push notifications not configured', not_configured: true });
    }
    return jsonResponse({ ok: true, key: VAPID_PUBLIC });
  }

  // ── subscribe ──────────────────────────────────────────────────────────
  if (action === 'subscribe') {
    const endpoint = String(body.endpoint || '').trim();
    const p256dh   = String(body.p256dh   || '').trim();
    const auth     = String(body.auth     || '').trim();
    const ua       = body.user_agent ? String(body.user_agent).slice(0, 240) : null;
    if (!endpoint || !p256dh || !auth) {
      return jsonResponse({ ok: false, error: 'endpoint, p256dh, auth required' }, 400);
    }
    if (payload.synthetic) {
      return jsonResponse({ ok: false, error: 'Provider impersonation cannot subscribe' }, 403);
    }
    // Upsert on (admin_user_id, endpoint). Same browser re-subscribing
    // (after Chrome re-enables push, e.g.) just bumps last_seen_at.
    const { data, error } = await sb.from('admin_push_subscriptions')
      .upsert({
        tenant_id: TID, admin_user_id: payload.sub,
        endpoint, p256dh, auth, user_agent: ua,
        last_seen_at: new Date().toISOString(),
      }, { onConflict: 'admin_user_id,endpoint' })
      .select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, id: data.id });
  }

  // ── unsubscribe ────────────────────────────────────────────────────────
  if (action === 'unsubscribe') {
    const endpoint = String(body.endpoint || '').trim();
    if (!endpoint) return jsonResponse({ ok: false, error: 'endpoint required' }, 400);
    if (payload.synthetic) return jsonResponse({ ok: true });
    await sb.from('admin_push_subscriptions').delete()
      .eq('tenant_id', TID).eq('admin_user_id', payload.sub).eq('endpoint', endpoint);
    return jsonResponse({ ok: true });
  }

  // ── list (caller's own only) ───────────────────────────────────────────
  if (action === 'list') {
    if (payload.synthetic) return jsonResponse({ ok: true, subscriptions: [] });
    const { data } = await sb.from('admin_push_subscriptions')
      .select('id, endpoint, user_agent, created_at, last_seen_at')
      .eq('tenant_id', TID).eq('admin_user_id', payload.sub)
      .order('created_at', { ascending: false });
    return jsonResponse({ ok: true, subscriptions: data ?? [] });
  }

  // ── test (sends a "PWA notifications enabled" push to caller) ──────────
  if (action === 'test') {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return jsonResponse({ ok: false, error: 'Push notifications not configured', not_configured: true });
    }
    if (payload.synthetic) return jsonResponse({ ok: false, error: 'Provider impersonation cannot test' }, 403);
    const { data: subs } = await sb.from('admin_push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('tenant_id', TID).eq('admin_user_id', payload.sub);
    if (!subs || subs.length === 0) {
      return jsonResponse({ ok: true, sent: 0, failed: 0, no_subscribers: true });
    }
    let sent = 0, failed = 0;
    await Promise.all(subs.map(async (s) => {
      const r = await sendOne(sb, s as never, {
        title: 'Poolside notifications are on ✓',
        body: 'You\'ll get a buzz here when your board needs to act on something.',
        url: '/club/admin/',
        tag: 'poolside-test',
        icon: '/icon-192.png', badge: '/icon-192.png',
      });
      if (r.ok) sent++; else failed++;
    }));
    return jsonResponse({ ok: true, sent, failed });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

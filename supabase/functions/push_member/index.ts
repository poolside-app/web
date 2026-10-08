// =============================================================================
// push_member — pop-up notifications on members' phones (PLAN.md N6)
// =============================================================================
// The member side of what push_admin does for the board. Doug, 2026-10-07:
// members get notices as pop-ups in the app (board replies, party decisions,
// plan receipts, announcements), and email where it makes sense. Texts are
// kept for "Text all members", sign-in codes and the welcome text.
//
// On iPhone a pop-up needs the app on the Home Screen (iOS 16.4+); in a
// Safari tab there is no PushManager, and the app says so.
//
// Member actions (member JWT):
//   { action: 'vapid_public_key' }                  → { ok, key }
//   { action: 'subscribe', endpoint, p256dh, auth } → { ok }
//   { action: 'unsubscribe', endpoint }             → { ok }
//   { action: 'test' }                              → { ok, sent }
//
// Internal (x-poolside-internal = service role, from other functions):
//   { action: 'send', tenant_id, member_ids? | household_ids? | all?, title, body, url?, tag? }
//     → { ok, sent, failed, reached }   reached = member ids at least one pop-up went to
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:doug@poolsideapp.com';
if (VAPID_PUBLIC && VAPID_PRIVATE) webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-poolside-internal',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

type Member = { sub: string; tid: string; hid: string };
async function verifyMember(token: string): Promise<Member | null> {
  if (!JWT_SECRET || !token) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'member' || !p.sub || !p.tid || !p.hid) return null;
    return p as unknown as Member;
  } catch { return null; }
}

type Row = { id: string; member_id: string; endpoint: string; p256dh: string; auth: string };

/** One pop-up. A dead endpoint (404/410) is deleted so it isn't tried again. */
async function sendOne(sb: ReturnType<typeof createClient>, row: Row, payload: Record<string, unknown>): Promise<boolean> {
  try {
    await webpush.sendNotification(
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      JSON.stringify(payload), { TTL: 60 * 60 * 24, urgency: 'high' as const });
    return true;
  } catch (e) {
    const status = (e as { statusCode?: number })?.statusCode ?? 0;
    if (status === 404 || status === 410) await sb.from('member_push_subscriptions').delete().eq('id', row.id);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return j({ ok: false, error: 'POST required' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'send') {
    if ((req.headers.get('x-poolside-internal') || '') !== SERVICE_ROLE) return j({ ok: false, error: 'Forbidden' }, 403);
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return j({ ok: true, sent: 0, failed: 0, reached: [], not_configured: true });
    const tenant_id = String(body.tenant_id ?? '');
    if (!tenant_id) return j({ ok: false, error: 'tenant_id required' }, 400);
    let q = sb.from('member_push_subscriptions').select('id, member_id, endpoint, p256dh, auth').eq('tenant_id', tenant_id);
    const memberIds = Array.isArray(body.member_ids) ? (body.member_ids as unknown[]).map(String) : null;
    const householdIds = Array.isArray(body.household_ids) ? (body.household_ids as unknown[]).map(String) : null;
    if (memberIds) q = q.in('member_id', memberIds.length ? memberIds : ['00000000-0000-0000-0000-000000000000']);
    else if (householdIds) q = q.in('household_id', householdIds.length ? householdIds : ['00000000-0000-0000-0000-000000000000']);
    else if (body.all !== true) return j({ ok: false, error: 'member_ids, household_ids or all required' }, 400);
    const { data: subs } = await q.limit(5000);
    // Only members still on an active roster.
    const ids = [...new Set((subs ?? []).map(s => s.member_id as string))];
    const live = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const { data } = await sb.from('household_members').select('id').in('id', ids.slice(i, i + 500)).eq('active', true);
      for (const m of data ?? []) live.add(m.id as string);
    }
    const payload = {
      title: String(body.title || 'Poolside'), body: String(body.body || ''),
      url: body.url ? String(body.url) : '/m/', tag: body.tag ? String(body.tag) : 'poolside-member',
      icon: '/icon-192.png', badge: '/icon-192.png',
    };
    let sent = 0, failed = 0;
    const reached = new Set<string>();
    await Promise.all((subs ?? []).filter(s => live.has(s.member_id as string)).map(async s => {
      if (await sendOne(sb, s as Row, payload)) { sent++; reached.add(s.member_id as string); } else failed++;
    }));
    return j({ ok: true, sent, failed, reached: [...reached] });
  }

  const auth = req.headers.get('authorization') || '';
  const m = await verifyMember(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!m) return j({ ok: false, error: 'Not authenticated' }, 401);

  if (action === 'vapid_public_key') {
    return VAPID_PUBLIC ? j({ ok: true, key: VAPID_PUBLIC }) : j({ ok: false, error: 'Notifications are not set up yet.' });
  }

  if (action === 'subscribe') {
    const endpoint = String(body.endpoint || '').trim();
    const p256dh = String(body.p256dh || '').trim();
    const authKey = String(body.auth || '').trim();
    if (!/^https:\/\//.test(endpoint) || !p256dh || !authKey) return j({ ok: false, error: 'endpoint, p256dh, auth required' }, 400);
    const { error } = await sb.from('member_push_subscriptions').upsert({
      tenant_id: m.tid, member_id: m.sub, household_id: m.hid, endpoint, p256dh, auth: authKey,
      user_agent: body.user_agent ? String(body.user_agent).slice(0, 240) : null,
      last_seen_at: new Date().toISOString(),
    }, { onConflict: 'member_id,endpoint' });
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'unsubscribe') {
    const endpoint = String(body.endpoint || '').trim();
    await sb.from('member_push_subscriptions').delete().eq('member_id', m.sub).eq('endpoint', endpoint);
    return j({ ok: true });
  }

  if (action === 'test') {
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) return j({ ok: false, error: 'Notifications are not set up yet.' });
    const { data: subs } = await sb.from('member_push_subscriptions').select('id, member_id, endpoint, p256dh, auth').eq('member_id', m.sub);
    let sent = 0;
    for (const s of subs ?? []) {
      if (await sendOne(sb, s as Row, { title: 'Notifications are on ✓', body: 'You\'ll get a pop-up here when the club has news for you.', url: '/m/', tag: 'poolside-test', icon: '/icon-192.png' })) sent++;
    }
    return j({ ok: true, sent });
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});

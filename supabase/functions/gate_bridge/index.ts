// =============================================================================
// gate_bridge — Pi-bridge polling protocol
// =============================================================================
// The Pi sitting on the club's LAN polls this endpoint every 1-2 seconds.
// Cloud → bridge: pending unlock commands.
// Bridge → cloud: command results + heartbeat.
//
// Auth: bridge_id + bridge_secret in headers. The bridge_secret is generated
// once and the cloud stores only its sha256 hash (the bridge keeps the
// plaintext locally, baked into its config file at provisioning time).
//
// Headers:
//   X-Bridge-Id:     <uuid from gate_panels.bridge_id>
//   X-Bridge-Secret: <plaintext bridge secret>
//
// Body actions:
//   { action: 'poll' }
//     → returns the oldest pending unlock for this tenant (and flips it
//       to 'in_flight'), OR null if no work. Updates bridge_last_seen_at.
//       Always returns the panel config so the bridge has fresh creds.
//
//   { action: 'complete', unlock_id, result_code, result_detail? }
//     → bridge reports an unlock finished (ok or failed)
//
//   { action: 'heartbeat', version? }
//     → no work being requested; just liveness check. Updates last_seen.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-bridge-id, x-bridge-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare so an attacker can't time-attack our hash check.
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const bridgeId     = req.headers.get('x-bridge-id') || '';
  const bridgeSecret = req.headers.get('x-bridge-secret') || '';
  if (!bridgeId || !bridgeSecret) {
    return jsonResponse({ ok: false, error: 'Missing bridge credentials' }, 401);
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Look up the gate_panels row by bridge_id, then verify secret hash.
  const { data: panel } = await sb.from('gate_panels')
    .select('id, tenant_id, status, panel_type, panel_host, panel_admin_user, panel_admin_password, bridge_secret_hash')
    .eq('bridge_id', bridgeId).maybeSingle();
  if (!panel) {
    return jsonResponse({ ok: false, error: 'Unknown bridge' }, 401);
  }
  if (!panel.bridge_secret_hash) {
    return jsonResponse({ ok: false, error: 'Bridge not yet provisioned — admin must rotate the secret' }, 401);
  }

  const incomingHash = await sha256Hex(bridgeSecret);
  if (!constantTimeEq(incomingHash, panel.bridge_secret_hash)) {
    return jsonResponse({ ok: false, error: 'Invalid bridge secret' }, 401);
  }

  if (panel.status !== 'active') {
    return jsonResponse({ ok: false, error: `Tenant gate add-on is in '${panel.status}' state, not active` }, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? 'heartbeat');

  // Update last-seen on every authenticated request, regardless of action.
  const heartbeatVersion = body.version ? String(body.version).slice(0, 32) : null;
  await sb.from('gate_panels').update({
    bridge_last_seen_at: new Date().toISOString(),
    bridge_version: heartbeatVersion ?? panel.bridge_version,
  }).eq('id', panel.id);

  // ── poll: hand the bridge work, if any ─────────────────────────────
  if (action === 'poll') {
    // Atomically claim the oldest pending unlock for this tenant by flipping
    // to 'in_flight'. If two bridges (impossible today, but future-proof) ever
    // poll concurrently, only one wins this update.
    const { data: pickedUp } = await sb.from('gate_unlocks')
      .update({
        status: 'in_flight',
        picked_up_at: new Date().toISOString(),
        bridge_id: panel.id,
      })
      .eq('tenant_id', panel.tenant_id)
      .eq('status', 'pending')
      .order('requested_at', { ascending: true })
      .limit(1)
      .select('id, requested_at, member_id, is_test, actor_kind');

    const command = (pickedUp && pickedUp.length) ? {
      id: pickedUp[0].id,
      type: 'unlock',
      requested_at: pickedUp[0].requested_at,
      is_test: pickedUp[0].is_test,
    } : null;

    return jsonResponse({
      ok: true,
      command,
      tenant: {
        // The bridge needs panel info to actually execute the command.
        panel_type: panel.panel_type,
        panel_host: panel.panel_host,
        panel_admin_user: panel.panel_admin_user,
        panel_admin_password: panel.panel_admin_password,
      },
      // Server time so the bridge can detect clock skew (its UNCLOSE call
      // depends on a fresh timestamp for some panels).
      server_time: new Date().toISOString(),
    });
  }

  // ── complete: bridge reports the result ────────────────────────────
  if (action === 'complete') {
    const id           = String(body.unlock_id ?? '').trim();
    const resultCode   = String(body.result_code ?? '').trim();
    const resultDetail = body.result_detail ? String(body.result_detail).slice(0, 500) : null;
    if (!id || !resultCode) return jsonResponse({ ok: false, error: 'unlock_id + result_code required' }, 400);

    const ok = resultCode === 'ok';
    const { error } = await sb.from('gate_unlocks').update({
      status: ok ? 'done' : 'failed',
      completed_at: new Date().toISOString(),
      result_code: resultCode,
      result_detail: resultDetail,
    }).eq('id', id).eq('tenant_id', panel.tenant_id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  // ── heartbeat: just touch last_seen_at (already done above) ──────────
  if (action === 'heartbeat') {
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

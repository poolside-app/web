// =============================================================================
// gate_bridge — Pi-bridge polling protocol
// =============================================================================
// The bridge on the club's LAN checks in here. Since PLAN.md AA it asks
// with `wait` and the check-in is held open, up to 2 minutes since AO.
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
//   { action: 'poll', wait? }
//     → returns the oldest pending unlock for this tenant (and flips it
//       to 'in_flight'), OR null if no work. Updates bridge_last_seen_at.
//       Always returns the panel config so the bridge has fresh creds.
//       With `wait` (seconds, up to 120; PLAN.md AA1, AO) the check-in is
//       held open and answered the moment an unlock is waiting. The answer's
//       `next_wait` tells the bridge how long to ask for next time.
//       The command's `door` says which door (PLAN.md AK): the front gate
//       by key alone, any other with its controller, address and door
//       number. A bridge before 1.2 is only handed front-gate unlocks.
//
//   { action: 'complete', unlock_id, result_code, result_detail? }
//     → bridge reports an unlock finished (ok or failed)
//
//   { action: 'heartbeat', version? }
//     → no work being requested; just liveness check. Updates last_seen.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { pollWait, MAX_WAIT_SEC, LOOK_EVERY_MS, STAMP_EVERY_MS } from '../_shared/bridge_poll.ts';
import { doorsReady, findDoor, commandDoor, OLD_BRIDGE_DOORS } from '../_shared/gate_doors.ts';
import { syncReady, diffSync, type SyncPlan, type SyncHave } from '../_shared/keyfob_sync.ts';

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

// The "season opened/closed: send the keyfob changes" to-do (keyfob.season,
// from tenant_settings), once the doors have the changes.
// deno-lint-ignore no-explicit-any
async function doneSeasonTodo(sb: any, tenantId: string, now: string) {
  await sb.from('admin_tasks').update({ completed_at: now })
    .eq('tenant_id', tenantId).eq('kind', 'keyfob.season').is('completed_at', null);
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
    .select('id, tenant_id, status, panel_type, panel_host, panel_admin_user, panel_admin_password, bridge_secret_hash, bridge_version, doors')
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
    // A bridge before 1.2 opens the front gate whatever it's handed, so it
    // only ever gets front-gate unlocks (PLAN.md AK3); another door waits
    // for the update (the board home doesn't offer one until then).
    const allDoors = doorsReady(heartbeatVersion);
    const mine = <T extends { or: (f: string) => T }>(q: T): T => allDoors ? q : q.or(OLD_BRIDGE_DOORS);
    const claim = async () => (await mine(sb.from('gate_unlocks')
      .update({
        status: 'in_flight',
        picked_up_at: new Date().toISOString(),
        bridge_id: panel.id,
      })
      .eq('tenant_id', panel.tenant_id)
      .eq('status', 'pending'))
      .order('requested_at', { ascending: true })
      .limit(1)
      .select('id, requested_at, member_id, is_test, actor_kind, door_key')).data;
    // Hold the check-in open (PLAN.md AA1): look every second for a
    // waiting unlock, until the bridge's wait runs out. A cheap look first,
    // then the claim. If the bridge has hung up, stop without claiming, so
    // an unlock is never marked picked up by a bridge that isn't listening.
    const deadline = Date.now() + pollWait(body.wait) * 1000;
    let pickedUp = await claim();
    let stamped = Date.now();
    // A keyfob sync waiting (PLAN.md AS4, bridge 1.4) also ends the hold;
    // looked for every 5 seconds.
    const canSync = syncReady(heartbeatVersion);
    const syncWaiting = async () => (await sb.from('keyfob_syncs').select('id', { count: 'exact', head: true })
      .eq('tenant_id', panel.tenant_id).eq('status', 'pending')).count ?? 0;
    let looks = 0;
    if (!pickedUp?.length && canSync && await syncWaiting()) looks = -1;
    while (!pickedUp?.length && Date.now() < deadline && looks >= 0) {
      await new Promise(r => setTimeout(r, LOOK_EVERY_MS));
      if (req.signal.aborted) return new Response(null, { status: 499 });
      const { count } = await mine(sb.from('gate_unlocks').select('id', { count: 'exact', head: true })
        .eq('tenant_id', panel.tenant_id).eq('status', 'pending'));
      if (count) pickedUp = await claim();
      else if (canSync && ++looks % 5 === 0 && await syncWaiting()) break;
      // A 2-minute hold (PLAN.md AO1): the bridge is still on the line, so
      // keep "last seen" as fresh as when it checked in every 20 seconds.
      else if (Date.now() - stamped >= STAMP_EVERY_MS) {
        stamped = Date.now();
        await sb.from('gate_panels').update({ bridge_last_seen_at: new Date().toISOString() }).eq('id', panel.id);
      }
    }

    // A door taken off the list after the tap: never let it fall back to
    // the front gate.
    if (pickedUp?.length && pickedUp[0].door_key && !findDoor(panel.doors, pickedUp[0].door_key)) {
      await sb.from('gate_unlocks').update({ status: 'failed', completed_at: new Date().toISOString(),
        result_code: 'unknown_door', result_detail: `door ${pickedUp[0].door_key} is no longer on file` }).eq('id', pickedUp[0].id);
      pickedUp = null;
    }

    const command = (pickedUp && pickedUp.length) ? {
      id: pickedUp[0].id,
      type: 'unlock',
      requested_at: pickedUp[0].requested_at,
      is_test: pickedUp[0].is_test,
      // Which door, and for any but the front gate its controller (PLAN.md AK3).
      door: commandDoor(findDoor(panel.doors, pickedUp[0].door_key)),
    } : null;

    // Doors first: a keyfob sync is handed out only when no unlock is waiting,
    // and only to a 1.4 bridge (PLAN.md AS4).
    let sync: { id: string; kind: string; plan: unknown } | null = null;
    if (!command && syncReady(heartbeatVersion)) {
      // "Update the oldest" only works when the sort column comes back too
      // (PLAN.md AW: without created_at here the first job was never handed out).
      const { data: claimed, error: claimErr } = await sb.from('keyfob_syncs')
        .update({ status: 'in_flight', picked_up_at: new Date().toISOString() })
        .eq('tenant_id', panel.tenant_id).eq('status', 'pending')
        .order('created_at', { ascending: true }).limit(1)
        .select('id, kind, plan, created_at');
      if (claimed?.length) sync = { id: claimed[0].id as string, kind: claimed[0].kind as string, plan: claimed[0].plan };
      else if (claimErr) {
        // A waiting job ends every hold at once, so one that can't be handed
        // out would turn 2-minute check-ins into one every 5 seconds. Fail it.
        console.error('keyfob sync claim failed:', claimErr.message);
        await sb.from('keyfob_syncs').update({ status: 'failed', completed_at: new Date().toISOString(),
          error: `Couldn't hand this to the gate computer: ${claimErr.message}`.slice(0, 500) })
          .eq('tenant_id', panel.tenant_id).eq('status', 'pending');
      }
    }

    return jsonResponse({
      ok: true,
      command,
      sync,
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
      // How long to ask for next time (PLAN.md AO2): set here, not on the club PC.
      next_wait: MAX_WAIT_SEC,
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

  // ── sync_done: the gate computer read or wrote the keyfobs (PLAN.md AS4) ──
  if (action === 'sync_done') {
    const id = String(body.id ?? '');
    const { data: job } = await sb.from('keyfob_syncs').select('id, kind, plan, auto, status')
      .eq('id', id).eq('tenant_id', panel.tenant_id).maybeSingle();
    if (!job) return jsonResponse({ ok: false, error: 'Unknown sync' }, 404);
    const result = (body.result ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    if (body.error) {
      await sb.from('keyfob_syncs').update({ status: 'failed', error: String(body.error).slice(0, 500), result, completed_at: now }).eq('id', id);
      return jsonResponse({ ok: true });
    }
    if (job.kind === 'check') {
      // What to write, worked out here from what it read.
      const d = diffSync(job.plan as SyncPlan, result as unknown as SyncHave);
      await sb.from('keyfob_syncs').update({ status: 'done', completed_at: now,
        result: { have: result, ops: d.ops, summary: d.summary, lines: d.lines } }).eq('id', id);
      // Automatic (the "Auto keyfob activations" switch is on): send them now.
      if (job.auto && d.ops.length) {
        await sb.from('keyfob_syncs').insert({ tenant_id: panel.tenant_id, kind: 'send', auto: true, check_id: id,
          plan: { controllers: ((job.plan ?? {}) as Record<string, unknown>).controllers ?? [], ops: d.ops } });
      }
      // The doors already match: nothing left of a season to-do (PLAN.md BE1).
      if (!d.ops.length && !d.summary.unreadable) await doneSeasonTodo(sb, panel.tenant_id as string, now);
      return jsonResponse({ ok: true, ops: d.ops.length });
    }
    const ops = (result.ops as Array<{ ok?: boolean; live?: boolean }> | undefined) ?? [];
    const failed = ops.filter(o => !o.ok || o.live === false).length;
    await sb.from('keyfob_syncs').update({ status: failed ? 'failed' : 'done', completed_at: now,
      error: failed ? `${failed} change${failed === 1 ? '' : 's'} didn't take. Check again.` : null,
      result: { ...result, summary: { sent: ops.length, live: ops.length - failed }, failed } }).eq('id', id);
    await sb.from('audit_log').insert({ tenant_id: panel.tenant_id, kind: 'keyfob.sync_done', entity_type: 'keyfob_sync', entity_id: id,
      summary: `Keyfobs on the doors: ${ops.length - failed} of ${ops.length} changes live${job.auto ? ' (nightly)' : ''}`, actor_kind: 'system' });
    // Sent, and every change took: the season's to-do is done (PLAN.md BE1).
    if (!failed) await doneSeasonTodo(sb, panel.tenant_id as string, now);
    return jsonResponse({ ok: true });
  }

  // ── heartbeat: just touch last_seen_at (already done above) ──────────
  if (action === 'heartbeat') {
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

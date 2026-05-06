// =============================================================================
// unlock_gate — member's "tap to unlock" endpoint + status poll
// =============================================================================
// Auth: member JWT. Three actions:
//
//   { action: 'tap' }
//     → validates eligibility, queues an unlock, returns its id
//
//   { action: 'status', id }
//     → returns the latest state of an in-flight unlock (member polls this
//       every 500ms-1s while the bridge picks up + executes)
//
//   { action: 'check' }
//     → just returns whether THIS member can currently unlock (button
//       enabled state on the home screen). No queue write.
//
// Eligibility for tap:
//   - tenant has gate_panels.status = 'active'
//   - member.can_unlock_gate = true
//   - member.active = true
//   - household.dues_paid_for_year = true   (the user's auto-enable rule)
//   - no pending unlock from this member in last 3 seconds (rate limit)
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
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type MemberPayload = { sub: string; kind: string; tid: string; hid?: string };

async function verifyMember(token: string): Promise<MemberPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'member' || !p.sub || !p.tid) return null;
    return p as unknown as MemberPayload;
  } catch { return null; }
}

// Compute eligibility for the calling member. Returns { can_unlock, reason }.
async function checkEligibility(
  sb: ReturnType<typeof createClient>,
  payload: MemberPayload,
): Promise<{ can_unlock: boolean; reason: string; tenant_active: boolean }> {
  const [{ data: panel }, { data: member }] = await Promise.all([
    sb.from('gate_panels').select('status').eq('tenant_id', payload.tid).maybeSingle(),
    sb.from('household_members').select('id, active, can_unlock_gate, household_id').eq('id', payload.sub).maybeSingle(),
  ]);
  const tenantActive = panel?.status === 'active';
  if (!tenantActive) return { can_unlock: false, reason: 'gate_not_enabled', tenant_active: false };
  if (!member?.active) return { can_unlock: false, reason: 'member_inactive', tenant_active: true };
  if (!member?.can_unlock_gate) return { can_unlock: false, reason: 'member_not_authorized', tenant_active: true };

  const { data: hh } = await sb.from('households')
    .select('dues_paid_for_year, active')
    .eq('id', member.household_id).maybeSingle();
  if (!hh?.active)               return { can_unlock: false, reason: 'household_inactive', tenant_active: true };
  if (!hh?.dues_paid_for_year)   return { can_unlock: false, reason: 'dues_unpaid', tenant_active: true };

  return { can_unlock: true, reason: 'ok', tenant_active: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyMember(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'check') {
    const elig = await checkEligibility(sb, payload);
    return jsonResponse({ ok: true, ...elig });
  }

  if (action === 'tap') {
    const elig = await checkEligibility(sb, payload);
    if (!elig.can_unlock) {
      // Members get human-readable reasons; the UI will format them.
      const messages: Record<string, string> = {
        gate_not_enabled:        'Your club doesn\'t have remote gate access set up.',
        member_inactive:         'Your membership is no longer active. Contact the board.',
        member_not_authorized:   'Your account isn\'t allowed to unlock the gate. Ask the board to enable it.',
        household_inactive:      'Your household is no longer active.',
        dues_unpaid:             'Your dues are unpaid for this season — pay first to enable gate access.',
      };
      return jsonResponse({
        ok: false,
        error: messages[elig.reason] || 'Not eligible to unlock the gate.',
        reason: elig.reason,
      }, 403);
    }

    // Rate limit: refuse if this member triggered an unlock in the last 3 seconds
    const since = new Date(Date.now() - 3000).toISOString();
    const { count: recent } = await sb.from('gate_unlocks')
      .select('id', { count: 'exact', head: true })
      .eq('member_id', payload.sub)
      .gte('requested_at', since);
    if ((recent ?? 0) > 0) {
      return jsonResponse({ ok: false, error: 'You just unlocked the gate — wait a moment before trying again.', reason: 'rate_limited' }, 429);
    }

    // Sanity: don't pile up dozens of pending requests if the bridge is offline.
    const { count: pendingForTenant } = await sb.from('gate_unlocks')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', payload.tid)
      .in('status', ['pending', 'in_flight']);
    if ((pendingForTenant ?? 0) > 20) {
      return jsonResponse({ ok: false, error: 'Gate system seems backed up. Try again in a moment or call the front desk.', reason: 'queue_full' }, 503);
    }

    const ipHeader = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '';
    const clientIp = ipHeader ? ipHeader.split(',')[0].trim().slice(0, 64) : null;

    const { data: row, error } = await sb.from('gate_unlocks').insert({
      tenant_id: payload.tid,
      member_id: payload.sub,
      status: 'pending',
      client_ip: clientIp,
      client_user_agent: req.headers.get('user-agent')?.slice(0, 200) || null,
      actor_kind: 'member',
    }).select('id, requested_at').single();
    if (error || !row) return jsonResponse({ ok: false, error: error?.message || 'Insert failed' }, 500);

    return jsonResponse({
      ok: true,
      unlock_id: row.id,
      requested_at: row.requested_at,
      message: 'Opening the gate…',
    });
  }

  if (action === 'status') {
    const id = String(body.id ?? '').trim();
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: row } = await sb.from('gate_unlocks')
      .select('id, status, result_code, result_detail, completed_at, member_id')
      .eq('id', id).eq('tenant_id', payload.tid).maybeSingle();
    if (!row) return jsonResponse({ ok: false, error: 'Unlock not found' }, 404);
    // Members can only see their own unlocks
    if (row.member_id !== payload.sub) return jsonResponse({ ok: false, error: 'Not your unlock' }, 403);
    return jsonResponse({
      ok: true,
      status: row.status,
      result_code: row.result_code,
      result_detail: row.result_detail,
      completed_at: row.completed_at,
    });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// =============================================================================
// payments_admin — unified "who owes what" view across the tenant
// =============================================================================
// Volunteer treasurers don't think in tables — they think "who hasn't paid".
// This rolls up every unpaid surface (dues, applications, programs, guest
// passes) into one list, with mark-paid actions that target the right table.
//
// Actions:
//   { action: 'list' }
//     → { ok, items: [{ kind, id, household_id, family_name, label, amount_cents, age_days, source, source_id }, ...] }
//
//   { action: 'mark_paid', source: 'application'|'program'|'guest_pass'|'dues',
//     source_id: <uuid>, household_id?: <uuid for 'dues'> }
//     → { ok }
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

type Payload = { sub: string; kind: string; tid: string };
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

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return ms > 0 ? Math.floor(ms / 86400_000) : 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    // Fetch everything in parallel — none of these depends on the others.
    const [
      { data: dueHouseholds },
      { data: apps },
      { data: progBookings },
      { data: passPacks },
    ] = await Promise.all([
      sb.from('households')
        .select('id, family_name, paid_until_year, decided_at:created_at')
        .eq('tenant_id', TID).eq('active', true).eq('dues_paid_for_year', false),
      sb.from('applications')
        .select('id, family_name, household_id, payment_method, decided_at, created_at')
        .eq('tenant_id', TID).eq('status', 'approved')
        .neq('payment_status', 'paid'),
      sb.from('program_bookings')
        .select('id, household_id, participant_name, program_id, created_at')
        .eq('tenant_id', TID).eq('paid', false).neq('status', 'cancelled'),
      sb.from('guest_pass_packs')
        .select('id, household_id, label, total_count, price_cents, created_at')
        .eq('tenant_id', TID).eq('paid', false).eq('active', true),
    ]);

    // Resolve household + program names in batches
    const hids = new Set<string>();
    (apps ?? []).forEach(a => a.household_id && hids.add(a.household_id));
    (progBookings ?? []).forEach(b => b.household_id && hids.add(b.household_id));
    (passPacks ?? []).forEach(p => hids.add(p.household_id));
    (dueHouseholds ?? []).forEach(h => hids.add(h.id));
    const { data: households } = hids.size
      ? await sb.from('households').select('id, family_name').in('id', [...hids])
      : { data: [] };
    const familyByHid = new Map((households ?? []).map(h => [h.id, h.family_name]));

    const progIds = [...new Set((progBookings ?? []).map(b => b.program_id))];
    const { data: programs } = progIds.length
      ? await sb.from('programs').select('id, name, price_cents').in('id', progIds).eq('tenant_id', TID)
      : { data: [] };
    const progByPid = new Map((programs ?? []).map(p => [p.id, p]));

    const items: Array<Record<string, unknown>> = [];

    for (const h of (dueHouseholds ?? [])) {
      items.push({
        source: 'dues',
        source_id: h.id,
        household_id: h.id,
        family_name: h.family_name,
        kind: 'Annual dues',
        label: `Dues for ${h.paid_until_year ?? new Date().getFullYear()}`,
        amount_cents: null,        // dues amount is set by tier on the household, not here
        age_days: null,
      });
    }

    for (const a of (apps ?? [])) {
      items.push({
        source: 'application',
        source_id: a.id,
        household_id: a.household_id,
        family_name: a.family_name,
        kind: 'Membership application',
        label: `${a.payment_method === 'venmo' ? 'Venmo' : 'Stripe'} payment pending`,
        amount_cents: null,
        age_days: ageDays(a.decided_at ?? a.created_at),
      });
    }

    for (const b of (progBookings ?? [])) {
      const p = progByPid.get(b.program_id);
      items.push({
        source: 'program',
        source_id: b.id,
        household_id: b.household_id,
        family_name: familyByHid.get(b.household_id ?? '') ?? null,
        kind: 'Program signup',
        label: `${p?.name ?? 'Program'} — ${b.participant_name}`,
        amount_cents: p?.price_cents ?? null,
        age_days: ageDays(b.created_at),
      });
    }

    for (const p of (passPacks ?? [])) {
      items.push({
        source: 'guest_pass',
        source_id: p.id,
        household_id: p.household_id,
        family_name: familyByHid.get(p.household_id) ?? null,
        kind: 'Guest passes',
        label: `${p.label} (${p.total_count})`,
        amount_cents: p.price_cents,
        age_days: ageDays(p.created_at),
      });
    }

    // Newest oldest first so the chase-list orders by who's been waiting longest
    items.sort((a, b) => ((b.age_days ?? -1) as number) - ((a.age_days ?? -1) as number));

    return jsonResponse({ ok: true, items });
  }

  if (action === 'mark_paid') {
    const source = String(body.source ?? '');
    const source_id = String(body.source_id ?? '');
    if (!source || !source_id) {
      return jsonResponse({ ok: false, error: 'source and source_id required' }, 400);
    }

    if (source === 'dues') {
      const { error } = await sb.from('households')
        .update({ dues_paid_for_year: true, updated_at: new Date().toISOString() })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      try {
        await sb.from('audit_log').insert({
          tenant_id: TID, kind: 'dues.marked_paid', entity_type: 'household', entity_id: source_id,
          summary: 'Admin marked annual dues paid',
          actor_id: payload.sub, actor_kind: 'tenant_admin',
        });
      } catch { /* ignore */ }
      return jsonResponse({ ok: true });
    }

    if (source === 'application') {
      const { error } = await sb.from('applications')
        .update({
          payment_status: 'paid',
          paid_at: new Date().toISOString(),
          verified_at: new Date().toISOString(),
          verified_by: payload.sub,
        })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      // Application.verify_payment also flips household.dues_paid_for_year — replicate that here
      const { data: app } = await sb.from('applications').select('household_id')
        .eq('id', source_id).maybeSingle();
      if (app?.household_id) {
        await sb.from('households')
          .update({ dues_paid_for_year: true })
          .eq('id', app.household_id).eq('tenant_id', TID);
      }
      return jsonResponse({ ok: true });
    }

    if (source === 'program') {
      const { error } = await sb.from('program_bookings')
        .update({ paid: true, updated_at: new Date().toISOString() })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    if (source === 'guest_pass') {
      const { error } = await sb.from('guest_pass_packs')
        .update({ paid: true, updated_at: new Date().toISOString() })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: `Unknown source: ${source}` }, 400);
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

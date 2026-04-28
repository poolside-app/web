// =============================================================================
// parties_admin — Per-tenant party booking review (admin side)
// =============================================================================
// Auth: tenant admin token. The member-side actions live in member_auth
// (request_party / cancel_my_party / list_my_parties).
//
// Actions:
//   { action: 'list', status?: 'pending'|'approved'|'rejected'|'cancelled'|'all' }
//     → { ok, bookings: [{ ...booking, household, requester }] }
//
//   { action: 'approve', id, admin_notes?, override?: { title?, body?, location?, starts_at?, ends_at? } }
//     → { ok, booking, event_id }
//        // Materializes an events row (kind='party') and links it back here.
//
//   { action: 'reject', id, admin_notes? }
//     → { ok, booking }
//
//   { action: 'cancel_admin', id }
//     → { ok }   // admin-side cancel (e.g. for a no-show after approval).
//                // If approved, also marks the linked event inactive.
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
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin' || !payload.sub || !payload.tid) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

const FIELDS = 'id, tenant_id, household_id, requested_by, title, body, starts_at, ends_at, expected_guests, location, status, admin_notes, decided_at, decided_by, event_id, created_at, updated_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
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

  // ── list ─────────────────────────────────────────────────────────────
  if (action === 'list') {
    const status = String(body.status ?? 'pending');
    let q = sb.from('party_bookings').select(FIELDS).eq('tenant_id', TID);
    if (status !== 'all') q = q.eq('status', status);
    const { data: bookings, error } = await q.order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    const rows = bookings ?? [];
    const householdIds = [...new Set(rows.map(b => b.household_id as string).filter(Boolean))];
    const memberIds    = [...new Set(rows.map(b => b.requested_by as string).filter(Boolean))];
    const [{ data: hhs }, { data: mems }] = await Promise.all([
      householdIds.length
        ? sb.from('households').select('id, family_name, fob_number, address, city')
            .in('id', householdIds)
        : Promise.resolve({ data: [] }),
      memberIds.length
        ? sb.from('household_members').select('id, name, email, phone_e164')
            .in('id', memberIds)
        : Promise.resolve({ data: [] }),
    ]);
    const hhMap = new Map((hhs ?? []).map(h => [h.id, h]));
    const memMap = new Map((mems ?? []).map(m => [m.id, m]));
    const enriched = rows.map(r => ({
      ...r,
      household: hhMap.get(r.household_id as string) ?? null,
      requester: memMap.get(r.requested_by as string) ?? null,
    }));
    return jsonResponse({ ok: true, bookings: enriched });
  }

  // ── approve ──────────────────────────────────────────────────────────
  if (action === 'approve') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: bk } = await sb.from('party_bookings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!bk) return jsonResponse({ ok: false, error: 'Booking not found' }, 404);
    if (bk.status !== 'pending') {
      return jsonResponse({ ok: false, error: `Already ${bk.status}` }, 409);
    }

    const ovr = (body.override ?? {}) as Record<string, unknown>;
    const eventTitle    = strOrNull(ovr.title)    ?? bk.title;
    const eventBody     = strOrNull(ovr.body)     ?? bk.body;
    const eventLocation = strOrNull(ovr.location) ?? bk.location;
    const eventStarts   = isoOrNull(ovr.starts_at) ?? bk.starts_at;
    const eventEnds     = ovr.ends_at !== undefined ? isoOrNull(ovr.ends_at) : bk.ends_at;

    // Pull household name to prefix the body so the event description is
    // useful at a glance.
    const { data: hh } = await sb.from('households')
      .select('family_name').eq('id', bk.household_id).maybeSingle();
    const guestStr = bk.expected_guests ? `${bk.expected_guests} expected guests` : null;
    const familyStr = hh?.family_name ? `Hosted by the ${hh.family_name}` : null;
    const composed = [familyStr, guestStr, eventBody]
      .filter(Boolean).join(' · ');

    const created_by = payload.synthetic ? null : payload.sub;
    const { data: ev, error: evErr } = await sb.from('events').insert({
      tenant_id: TID, title: eventTitle,
      body: composed || null,
      kind: 'party',
      location: eventLocation,
      starts_at: eventStarts,
      ends_at: eventEnds,
      all_day: false,
      created_by,
    }).select('id').single();
    if (evErr) return jsonResponse({ ok: false, error: evErr.message }, 500);

    const decided_by = payload.synthetic ? null : payload.sub;
    const { data: updated, error: bkErr } = await sb.from('party_bookings').update({
      status: 'approved',
      admin_notes: strOrNull(body.admin_notes),
      decided_at: new Date().toISOString(),
      decided_by,
      event_id: ev.id,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (bkErr) {
      // Roll back the event so we don't leave an orphan.
      await sb.from('events').delete().eq('id', ev.id);
      return jsonResponse({ ok: false, error: bkErr.message }, 500);
    }
    return jsonResponse({ ok: true, booking: updated, event_id: ev.id });
  }

  // ── reject ───────────────────────────────────────────────────────────
  if (action === 'reject') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const decided_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('party_bookings').update({
      status: 'rejected',
      admin_notes: strOrNull(body.admin_notes),
      decided_at: new Date().toISOString(),
      decided_by,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).eq('status', 'pending')
      .select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data) return jsonResponse({ ok: false, error: 'Booking not pending' }, 409);
    return jsonResponse({ ok: true, booking: data });
  }

  // ── cancel_admin ─────────────────────────────────────────────────────
  if (action === 'cancel_admin') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: bk } = await sb.from('party_bookings')
      .select('id, status, event_id').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!bk) return jsonResponse({ ok: false, error: 'Booking not found' }, 404);

    await sb.from('party_bookings').update({
      status: 'cancelled',
      admin_notes: strOrNull(body.admin_notes) ?? bk['admin_notes' as keyof typeof bk] ?? null,
      decided_at: new Date().toISOString(),
      decided_by: payload.synthetic ? null : payload.sub,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID);

    // If we already materialized an event, soft-delete it so it leaves the calendar.
    if (bk.event_id) {
      await sb.from('events').update({
        active: false, updated_at: new Date().toISOString(),
      }).eq('id', bk.event_id).eq('tenant_id', TID);
    }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

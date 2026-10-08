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
//   { action: 'settings_get' } / { action: 'settings_save', length_hours?, fee_cents?, auto_approve? }
//     → { ok, length_hours, fee_cents, auto_approve, hold_days }
//        how long every party runs (N3), the fee, and whether an open time is
//        approved on the spot (PLAN.md O)
//
//   { action: 'cancel_admin', id }
//     → { ok }   // admin-side cancel (e.g. for a no-show after approval).
//                // If approved, also marks the linked event inactive.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope } from '../_shared/auth.ts';
import { partyWhen, fmtPoolDate, zoneOrDefault } from '../_shared/pool_time.ts';

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

const FIELDS = 'id, tenant_id, household_id, requested_by, title, body, starts_at, ends_at, expected_guests, location, status, admin_notes, decided_at, decided_by, event_id, price_cents, payment_method, payment_status, paid_at, verified_at, verified_by, stripe_session_id, policies_accepted, accepted_at, created_at, updated_at, pool_date';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
/** A pop-up about a party in the family's app (N6). Best-effort: the email
 *  that goes with each decision is the record. */
async function partyPop(tenantId: string, householdId: string | null, title: string, body: string): Promise<void> {
  if (!householdId) return;
  try {
    const { pushMembers } = await import('../_shared/member_notify.ts');
    await pushMembers({ tenant_id: tenantId, household_ids: [householdId], title, body, url: '/m/#parties', tag: 'party' });
  } catch (e) { console.error('party pop-up:', (e as Error).message); }
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

  // Scope gate: this function's admin actions require the 'parties' scope.
  // Synthetic webhook tokens bypass; super + owner roles bypass.
  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(createClient(SUPABASE_URL, SERVICE_ROLE), payload as never, 'parties'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: parties' }, 403);
  }
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
  // Two-phase booking model: APPROVE = "yes you can host this party, now
  // pay". The calendar event is NOT created yet — it's reserved until the
  // payment lands. This keeps the day open for other paying parties if the
  // approved one ghosts.
  // ── settings: how long every party runs (N3) ──────────────────────────
  if (action === 'settings_get' || action === 'settings_save') {
    const { partySettings } = await import('../_shared/party_slots.ts');
    const { data: row } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const value = (row?.value as Record<string, unknown> | undefined) ?? {};
    const shape = (v: unknown) => { const p = partySettings(v); return { length_hours: p.hours, fee_cents: p.fee_cents, auto_approve: p.auto_approve, hold_days: p.hold_days }; };
    if (action === 'settings_get') return jsonResponse({ ok: true, ...shape(value) });
    const parties = { ...((value.parties as Record<string, unknown> | undefined) ?? {}) };
    if (body.length_hours !== undefined) {
      const hours = Number(body.length_hours);
      if (!Number.isFinite(hours) || hours < 1 || hours > 12) return jsonResponse({ ok: false, error: 'Pick 1 to 12 hours.' }, 400);
      parties.length_hours = Math.round(hours * 2) / 2;
    }
    if (body.fee_cents !== undefined) {
      const fee = Number(body.fee_cents);
      if (!Number.isFinite(fee) || fee < 0 || fee > 500000) return jsonResponse({ ok: false, error: 'Enter a party fee in dollars.' }, 400);
      parties.fee_cents = Math.round(fee);
    }
    if (body.auto_approve !== undefined) parties.auto_approve = body.auto_approve === true;
    const next = { ...value, parties };
    const { error } = row
      ? await sb.from('settings').update({ value: next }).eq('tenant_id', TID)
      : await sb.from('settings').insert({ tenant_id: TID, value: next });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, ...shape(next) });
  }

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
    // A new start time moves the whole party: it still runs the club's set
    // length (N3). The calendar event isn't created until payment confirms.
    const decided_by = payload.synthetic ? null : payload.sub;
    const { partyHours, partyEnd } = await import('../_shared/party_length.ts');
    const { partySettings, bookedClashes } = await import('../_shared/party_slots.ts');
    const { data: lenRow } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const newStart = isoOrNull(ovr.starts_at);
    const newEnd = newStart ? partyEnd(newStart, partyHours(lenRow?.value)) : null;

    // Two parties can share a day, not a time (PLAN.md O): refuse a time
    // another party has already booked.
    const taken = await bookedClashes(sb, TID, { id, starts_at: newStart ?? bk.starts_at, ends_at: newEnd ?? bk.ends_at }, partySettings(lenRow?.value));
    if (taken.length) {
      return jsonResponse({ ok: false, error: `That time overlaps "${taken[0].title}", already booked. Pick another start time, or reject this request.` }, 409);
    }
    const { data: updated, error: bkErr } = await sb.from('party_bookings').update({
      status: 'approved',
      admin_notes: strOrNull(body.admin_notes),
      decided_at: new Date().toISOString(),
      decided_by,
      title: strOrNull(ovr.title) ?? bk.title,
      body: ovr.body !== undefined ? strOrNull(ovr.body) : bk.body,
      location: ovr.location !== undefined ? strOrNull(ovr.location) : bk.location,
      starts_at: newStart ?? bk.starts_at,
      ends_at: newEnd ?? bk.ends_at,
      price_cents: ovr.price_cents !== undefined && ovr.price_cents !== null && ovr.price_cents !== ''
        ? Math.max(0, Math.trunc(Number(ovr.price_cents) || 0))
        : bk.price_cents,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (bkErr) return jsonResponse({ ok: false, error: bkErr.message }, 500);

    // Close the original "party.requested" admin task — admin made a call.
    await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: decided_by })
      .eq('tenant_id', TID).eq('source_kind', 'party_booking').eq('source_id', id)
      .eq('kind', 'party.requested').is('completed_at', null);

    // Email the requesting member with payment instructions.
    try {
      const { data: requester } = await sb.from('household_members')
        .select('name, email').eq('id', bk.requested_by).maybeSingle();
      if (requester?.email) {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        const { data: tenant } = await sb.from('tenants').select('display_name, slug, timezone').eq('id', TID).maybeSingle();
        const { data: settings } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
        const sv = (settings?.value as Record<string, unknown> | undefined) ?? {};
        const venmoHandle = (sv.payments as Record<string, unknown> | undefined)?.venmo_handle as string | undefined;
        await renderAndSend(sb, {
          tenantId: TID, templateKey: 'party_approved_pay',
          to: requester.email as string,
          variables: {
            tenant_name: tenant?.display_name || 'Your club',
            primary_name: requester.name as string,
            party_title: updated.title,
            ...partyWhen(updated.starts_at as string, zoneOrDefault(tenant?.timezone)),
            price: updated.price_cents ? `$${(updated.price_cents / 100).toFixed(0)}` : 'see club',
            venmo_handle: venmoHandle ? String(venmoHandle).replace(/^@+/, '') : '',
            club_url: tenant ? `https://${tenant.slug}.poolsideapp.com` : '',
            member_url: tenant ? `https://${tenant.slug}.poolsideapp.com/m/index.html#parties` : '',
          },
        });
      }
    } catch { /* non-fatal */ }
    // And a pop-up in the family's app (N6). The email above stays: it has
    // the payment details.
    await partyPop(TID, bk.household_id as string, `🎉 ${updated.title} is approved`,
      updated.price_cents ? 'Pay to lock in the date. Details are in the app.' : 'See the details in the app.');

    return jsonResponse({ ok: true, booking: updated });
  }

  // ── verify_payment (Venmo: admin confirms payment landed) ────────────
  // Flips party to confirmed: marks paid, materializes the calendar event,
  // closes the venmo-claim task. The unique partial index on (tenant_id,
  // pool_date) where status=approved and payment_status=paid is the
  // last-line day-block defense — if a race lets two parties get to this
  // step on the same day, the second insert here errors cleanly.
  if (action === 'verify_payment') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const method = String(body.method ?? 'venmo');
    if (!['venmo', 'stripe'].includes(method)) {
      return jsonResponse({ ok: false, error: 'Invalid payment method' }, 400);
    }
    const { data: bk } = await sb.from('party_bookings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!bk) return jsonResponse({ ok: false, error: 'Booking not found' }, 404);
    if (bk.status !== 'approved') {
      return jsonResponse({ ok: false, error: 'Approve the party first' }, 409);
    }
    if (bk.payment_status === 'paid') {
      return jsonResponse({ ok: false, error: 'Already verified' }, 409);
    }

    // Last check before the money books it: no other booked party at this
    // time (two can share a day, PLAN.md O).
    const { partySettings, bookedClashes } = await import('../_shared/party_slots.ts');
    const { data: slotRow } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const taken = (await bookedClashes(sb, TID, bk as never, partySettings(slotRow?.value))).filter(r => r.payment_status === 'paid');
    if (taken.length) {
      return jsonResponse({ ok: false, error: `"${taken[0].title}" is already booked at that time. Cancel one before verifying this.` }, 409);
    }

    // Materialize calendar event now that payment is confirmed.
    const { data: hh } = await sb.from('households')
      .select('family_name').eq('id', bk.household_id).maybeSingle();
    const guestStr = bk.expected_guests ? `${bk.expected_guests} expected guests` : null;
    const familyStr = hh?.family_name ? `Hosted by the ${hh.family_name}` : null;
    const composed = [familyStr, guestStr, bk.body].filter(Boolean).join(' · ');
    const verified_by = payload.synthetic ? null : payload.sub;
    const { data: ev, error: evErr } = await sb.from('events').insert({
      tenant_id: TID, title: bk.title, body: composed || null, kind: 'party',
      location: bk.location, starts_at: bk.starts_at, ends_at: bk.ends_at,
      all_day: false, created_by: verified_by,
    }).select('id').single();
    if (evErr) return jsonResponse({ ok: false, error: evErr.message }, 500);

    const now = new Date().toISOString();
    const { data: updated, error: bkErr } = await sb.from('party_bookings').update({
      payment_status: 'paid',
      payment_method: method,
      paid_at: now,
      verified_at: now,
      verified_by,
      event_id: ev.id,
      updated_at: now,
    }).eq('id', id).eq('tenant_id', TID).select(FIELDS).single();
    if (bkErr) {
      await sb.from('events').delete().eq('id', ev.id);
      return jsonResponse({ ok: false, error: bkErr.message }, 500);
    }

    // Close any party.venmo_claim or party.requested tasks.
    await sb.from('admin_tasks')
      .update({ completed_at: now, completed_by: verified_by })
      .eq('tenant_id', TID).eq('source_kind', 'party_booking').eq('source_id', id)
      .in('kind', ['party.requested', 'party.venmo_claim']).is('completed_at', null);

    // Confirmation email to the host: party is officially booked.
    try {
      const { data: requester } = await sb.from('household_members')
        .select('name, email').eq('id', bk.requested_by).maybeSingle();
      if (requester?.email) {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        const { data: tenant } = await sb.from('tenants').select('display_name, slug, timezone').eq('id', TID).maybeSingle();
        await renderAndSend(sb, {
          tenantId: TID, templateKey: 'party_confirmed',
          to: requester.email as string,
          variables: {
            tenant_name: tenant?.display_name || 'Your club',
            primary_name: requester.name as string,
            party_title: updated.title,
            ...partyWhen(bk.starts_at as string, zoneOrDefault(tenant?.timezone)),
            club_url: tenant ? `https://${tenant.slug}.poolsideapp.com` : '',
          },
        });
      }
    } catch { /* non-fatal */ }
    await partyPop(TID, bk.household_id as string, `✅ ${updated.title} is booked`, 'Payment received. It\'s on the club calendar.');

    return jsonResponse({ ok: true, booking: updated, event_id: ev.id });
  }

  // ── reject ───────────────────────────────────────────────────────────
  if (action === 'reject') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const decided_by = payload.synthetic ? null : payload.sub;
    const adminNotes = strOrNull(body.admin_notes);
    const { data, error } = await sb.from('party_bookings').update({
      status: 'rejected',
      admin_notes: adminNotes,
      decided_at: new Date().toISOString(),
      decided_by,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).eq('status', 'pending')
      .select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data) return jsonResponse({ ok: false, error: 'Booking not pending' }, 409);

    // Close the party.requested admin task — board has decided.
    await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: decided_by })
      .eq('tenant_id', TID).eq('source_kind', 'party_booking').eq('source_id', id)
      .eq('kind', 'party.requested').is('completed_at', null);

    // Email the member so they're not left wondering. Even minimal admin
    // notes are useful — the template falls back gracefully if blank.
    try {
      const { data: requester } = await sb.from('household_members')
        .select('name, email').eq('id', data.requested_by).maybeSingle();
      if (requester?.email) {
        const { renderAndSend } = await import('../_shared/email_template.ts');
        const { data: tenant } = await sb.from('tenants').select('display_name, slug, timezone').eq('id', TID).maybeSingle();
        await renderAndSend(sb, {
          tenantId: TID, templateKey: 'party_rejected',
          to: requester.email as string,
          variables: {
            tenant_name: tenant?.display_name || 'Your club',
            primary_name: requester.name as string,
            party_title: data.title,
            party_date: fmtPoolDate(data.starts_at as string, zoneOrDefault(tenant?.timezone)),
            admin_notes: adminNotes || 'No reason was provided. Reach out to the board if you have questions.',
            club_url: tenant ? `https://${tenant.slug}.poolsideapp.com` : '',
          },
        });
      }
    } catch { /* non-fatal */ }
    await partyPop(TID, data.household_id as string, `${data.title} wasn't approved`, adminNotes ? String(adminNotes).slice(0, 140) : 'See the details in the app.');

    return jsonResponse({ ok: true, booking: data });
  }

  // ── cancel_admin ─────────────────────────────────────────────────────
  if (action === 'cancel_admin') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    // Need full booking row for admin_notes preservation + event cleanup +
    // member email after cancel. The previous selection of just (id, status,
    // event_id) caused admin_notes to silently null out on cancel.
    const { data: bk } = await sb.from('party_bookings').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!bk) return jsonResponse({ ok: false, error: 'Booking not found' }, 404);

    const decided_by = payload.synthetic ? null : payload.sub;
    const newAdminNotes = strOrNull(body.admin_notes) ?? (bk.admin_notes as string | null) ?? null;
    await sb.from('party_bookings').update({
      status: 'cancelled',
      admin_notes: newAdminNotes,
      decided_at: new Date().toISOString(),
      decided_by,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID);

    // If we already materialized an event, soft-delete it so it leaves the calendar.
    if (bk.event_id) {
      await sb.from('events').update({
        active: false, updated_at: new Date().toISOString(),
      }).eq('id', bk.event_id).eq('tenant_id', TID);
    }

    // Close any open admin tasks for this party — the board already acted.
    await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: decided_by })
      .eq('tenant_id', TID).eq('source_kind', 'party_booking').eq('source_id', id)
      .in('kind', ['party.requested', 'party.venmo_claim']).is('completed_at', null);

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

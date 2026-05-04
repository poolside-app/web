// =============================================================================
// programs — Bookings engine: swim lessons, yoga, camp, clinics
// =============================================================================
// One model serves every recurring class-style offering. Admins create
// programs (a name + schedule + capacity + price); households book a spot
// for one of their members. Payment is a manual flag for now — Stripe
// Connect arrives later and flips `paid` automatically on checkout success.
//
// Public actions (no auth):
//   { action: 'list_public', slug }
//     → { ok, programs: [...] }     — only active, capacity & spots_left
//
// Member actions (member JWT):
//   { action: 'my_bookings' }
//     → { ok, bookings: [...] }
//   { action: 'book', program_id, member_id?, participant_name, notes? }
//     → { ok, booking } | { ok: false, error }
//   { action: 'cancel_booking', booking_id }
//     → { ok }
//
// Admin actions (tenant_admin JWT):
//   { action: 'list', active_only? }
//   { action: 'create', name, ... }
//   { action: 'update', id, ...patch }
//   { action: 'delete', id }                     — soft delete (active=false)
//   { action: 'roster', program_id }             — { ok, program, bookings }
//   { action: 'admin_book', program_id, household_id, member_id?, participant_name }
//   { action: 'mark_paid', booking_id, paid }
//   { action: 'cancel_booking_admin', booking_id }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope } from '../_shared/auth.ts';

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

async function getKey(): Promise<CryptoKey | null> {
  if (!JWT_SECRET) return null;
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

type Payload = {
  sub: string; kind: string; tid: string;
  hid?: string; synthetic?: boolean;
};
async function verifyToken(token: string): Promise<Payload | null> {
  const key = await getKey();
  if (!key) return null;
  try {
    const p = await verify(token, key) as Record<string, unknown>;
    if (!p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const VALID_AUDIENCE = new Set(['kids', 'adults', 'all']);
const VALID_WEEKDAYS = new Set(['mon','tue','wed','thu','fri','sat','sun']);

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}
function dateOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}
function timeOrNull(v: unknown): string | null {
  if (!v) return null;
  const s = String(v).trim();
  if (!/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return null;
  return s;
}
function normalizeWeekdays(v: unknown): string | null {
  if (!v) return null;
  const parts = String(v).toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const ok = parts.filter(p => VALID_WEEKDAYS.has(p));
  return ok.length ? ok.join(',') : null;
}

const PROGRAM_FIELDS = 'id, tenant_id, name, description, audience, weekdays, start_time, end_time, start_date, end_date, capacity, price_cents, instructor, location, active, created_at, updated_at';
const BOOKING_FIELDS = 'id, tenant_id, program_id, household_id, member_id, participant_name, status, paid, notes, created_at, updated_at';

async function spotsLeft(sb: ReturnType<typeof createClient>, programId: string, capacity: number): Promise<number> {
  const { count } = await sb.from('program_bookings')
    .select('id', { count: 'exact', head: true })
    .eq('program_id', programId).eq('status', 'confirmed');
  const taken = count ?? 0;
  return Math.max(0, capacity - taken);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── Public list (no auth) ───────────────────────────────────────────────
  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name')
      .eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    const { data: programs } = await sb.from('programs').select(PROGRAM_FIELDS)
      .eq('tenant_id', tenant.id).eq('active', true)
      .order('start_date', { ascending: true, nullsFirst: false });
    const out = await Promise.all((programs ?? []).map(async (p) => ({
      ...p,
      spots_left: await spotsLeft(sb, p.id, p.capacity),
    })));
    return jsonResponse({ ok: true, programs: out });
  }

  // Everything below requires auth.
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyToken(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // Scope gate: this function's admin actions require the 'programs' scope.
  // Synthetic webhook tokens bypass; super + owner roles bypass.
  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(sb, payload as never, 'programs'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: programs' }, 403);
  }
  const TID = payload.tid;
  const isAdmin  = payload.kind === 'tenant_admin';
  const isMember = payload.kind === 'member';

  // ── Member actions ──────────────────────────────────────────────────────
  if (isMember) {
    const HID = payload.hid;
    if (!HID) return jsonResponse({ ok: false, error: 'Member token missing household' }, 401);

    if (action === 'my_bookings') {
      const { data: bookings } = await sb.from('program_bookings')
        .select(BOOKING_FIELDS)
        .eq('tenant_id', TID).eq('household_id', HID)
        .order('created_at', { ascending: false });
      const ids = [...new Set((bookings ?? []).map(b => b.program_id))];
      const { data: programs } = ids.length
        ? await sb.from('programs').select(PROGRAM_FIELDS).in('id', ids).eq('tenant_id', TID)
        : { data: [] };
      const byId = new Map((programs ?? []).map(p => [p.id, p]));
      return jsonResponse({
        ok: true,
        bookings: (bookings ?? []).map(b => ({ ...b, program: byId.get(b.program_id) ?? null })),
      });
    }

    if (action === 'book') {
      const program_id  = String(body.program_id ?? '');
      const member_id   = strOrNull(body.member_id);
      const participant_name = String(body.participant_name ?? '').trim();
      if (!program_id) return jsonResponse({ ok: false, error: 'program_id required' }, 400);
      if (!participant_name) return jsonResponse({ ok: false, error: 'Participant name is required' }, 400);

      const { data: program } = await sb.from('programs').select(PROGRAM_FIELDS)
        .eq('id', program_id).eq('tenant_id', TID).maybeSingle();
      if (!program || !program.active) return jsonResponse({ ok: false, error: 'Program not found' }, 404);

      // member_id, if given, must belong to this household
      if (member_id) {
        const { data: m } = await sb.from('household_members')
          .select('id, household_id, active')
          .eq('id', member_id).maybeSingle();
        if (!m || m.household_id !== HID || !m.active) {
          return jsonResponse({ ok: false, error: 'Member not in your household' }, 403);
        }
      }

      const left = await spotsLeft(sb, program.id, program.capacity);
      const status = left > 0 ? 'confirmed' : 'waitlisted';

      const { data, error } = await sb.from('program_bookings').insert({
        tenant_id: TID, program_id, household_id: HID,
        member_id: member_id || null,
        participant_name,
        status,
        notes: strOrNull(body.notes),
      }).select(BOOKING_FIELDS).single();
      if (error) {
        // unique(program_id, member_id) — friendlier message
        if (String(error.message).toLowerCase().includes('unique')) {
          return jsonResponse({ ok: false, error: 'That participant is already signed up for this program' }, 409);
        }
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
      return jsonResponse({ ok: true, booking: data });
    }

    if (action === 'cancel_booking') {
      const bid = String(body.booking_id ?? '');
      if (!bid) return jsonResponse({ ok: false, error: 'booking_id required' }, 400);
      const { data: bk } = await sb.from('program_bookings').select('id, household_id, status')
        .eq('id', bid).eq('tenant_id', TID).maybeSingle();
      if (!bk) return jsonResponse({ ok: false, error: 'Not found' }, 404);
      if (bk.household_id !== HID) return jsonResponse({ ok: false, error: 'Not yours' }, 403);
      if (bk.status === 'cancelled') return jsonResponse({ ok: true });
      const { error } = await sb.from('program_bookings')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', bid).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: `Unknown member action: ${action}` }, 400);
  }

  // ── Admin actions ──────────────────────────────────────────────────────
  if (!isAdmin) return jsonResponse({ ok: false, error: 'Forbidden' }, 403);

  if (action === 'list') {
    let q = sb.from('programs').select(PROGRAM_FIELDS).eq('tenant_id', TID);
    if (body.active_only) q = q.eq('active', true);
    q = q.order('start_date', { ascending: false, nullsFirst: false });
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const out = await Promise.all((data ?? []).map(async (p) => ({
      ...p, spots_left: await spotsLeft(sb, p.id, p.capacity),
    })));
    return jsonResponse({ ok: true, programs: out });
  }

  if (action === 'create') {
    const name = String(body.name ?? '').trim();
    if (!name) return jsonResponse({ ok: false, error: 'Name is required' }, 400);
    if (name.length > 140) return jsonResponse({ ok: false, error: 'Name too long' }, 400);

    const audience = String(body.audience ?? 'all');
    if (!VALID_AUDIENCE.has(audience)) return jsonResponse({ ok: false, error: 'Invalid audience' }, 400);

    const capacity    = Math.max(0, intOrNull(body.capacity) ?? 12);
    const price_cents = Math.max(0, intOrNull(body.price_cents) ?? 0);

    const { data, error } = await sb.from('programs').insert({
      tenant_id: TID, name, audience, capacity, price_cents,
      description: strOrNull(body.description),
      weekdays:    normalizeWeekdays(body.weekdays),
      start_time:  timeOrNull(body.start_time),
      end_time:    timeOrNull(body.end_time),
      start_date:  dateOrNull(body.start_date),
      end_date:    dateOrNull(body.end_date),
      instructor:  strOrNull(body.instructor),
      location:    strOrNull(body.location),
    }).select(PROGRAM_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, program: { ...data, spots_left: data.capacity } });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) {
      const v = String(body.name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Name cannot be empty' }, 400);
      if (v.length > 140) return jsonResponse({ ok: false, error: 'Name too long' }, 400);
      patch.name = v;
    }
    if (body.description !== undefined) patch.description = strOrNull(body.description);
    if (body.audience !== undefined) {
      const a = String(body.audience);
      if (!VALID_AUDIENCE.has(a)) return jsonResponse({ ok: false, error: 'Invalid audience' }, 400);
      patch.audience = a;
    }
    if (body.weekdays    !== undefined) patch.weekdays    = normalizeWeekdays(body.weekdays);
    if (body.start_time  !== undefined) patch.start_time  = timeOrNull(body.start_time);
    if (body.end_time    !== undefined) patch.end_time    = timeOrNull(body.end_time);
    if (body.start_date  !== undefined) patch.start_date  = dateOrNull(body.start_date);
    if (body.end_date    !== undefined) patch.end_date    = dateOrNull(body.end_date);
    if (body.capacity    !== undefined) patch.capacity    = Math.max(0, intOrNull(body.capacity) ?? 0);
    if (body.price_cents !== undefined) patch.price_cents = Math.max(0, intOrNull(body.price_cents) ?? 0);
    if (body.instructor  !== undefined) patch.instructor  = strOrNull(body.instructor);
    if (body.location    !== undefined) patch.location    = strOrNull(body.location);
    if (body.active      !== undefined) patch.active      = !!body.active;

    const { data, error } = await sb.from('programs').update(patch)
      .eq('id', id).eq('tenant_id', TID)
      .select(PROGRAM_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, program: { ...data, spots_left: await spotsLeft(sb, data.id, data.capacity) } });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('programs').update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'roster') {
    const program_id = String(body.program_id ?? '');
    if (!program_id) return jsonResponse({ ok: false, error: 'program_id required' }, 400);
    const { data: program } = await sb.from('programs').select(PROGRAM_FIELDS)
      .eq('id', program_id).eq('tenant_id', TID).maybeSingle();
    if (!program) return jsonResponse({ ok: false, error: 'Program not found' }, 404);
    const { data: bookings } = await sb.from('program_bookings').select(BOOKING_FIELDS)
      .eq('tenant_id', TID).eq('program_id', program_id)
      .order('status', { ascending: true })
      .order('created_at', { ascending: true });
    // Decorate with household family_name
    const hids = [...new Set((bookings ?? []).map(b => b.household_id))];
    const { data: households } = hids.length
      ? await sb.from('households').select('id, family_name').in('id', hids)
      : { data: [] };
    const byHid = new Map((households ?? []).map(h => [h.id, h.family_name]));
    return jsonResponse({
      ok: true, program,
      bookings: (bookings ?? []).map(b => ({ ...b, family_name: byHid.get(b.household_id) ?? null })),
    });
  }

  if (action === 'admin_book') {
    const program_id      = String(body.program_id ?? '');
    const household_id    = String(body.household_id ?? '');
    const participant_name = String(body.participant_name ?? '').trim();
    const member_id       = strOrNull(body.member_id);
    if (!program_id || !household_id || !participant_name) {
      return jsonResponse({ ok: false, error: 'program_id, household_id, participant_name required' }, 400);
    }
    const { data: program } = await sb.from('programs').select(PROGRAM_FIELDS)
      .eq('id', program_id).eq('tenant_id', TID).maybeSingle();
    if (!program) return jsonResponse({ ok: false, error: 'Program not found' }, 404);
    const left = await spotsLeft(sb, program.id, program.capacity);
    const status = left > 0 ? 'confirmed' : 'waitlisted';
    const { data, error } = await sb.from('program_bookings').insert({
      tenant_id: TID, program_id, household_id,
      member_id: member_id || null,
      participant_name, status,
      notes: strOrNull(body.notes),
    }).select(BOOKING_FIELDS).single();
    if (error) {
      if (String(error.message).toLowerCase().includes('unique')) {
        return jsonResponse({ ok: false, error: 'Participant already signed up' }, 409);
      }
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
    return jsonResponse({ ok: true, booking: data });
  }

  if (action === 'mark_paid') {
    const bid = String(body.booking_id ?? '');
    if (!bid) return jsonResponse({ ok: false, error: 'booking_id required' }, 400);
    const paid = body.paid !== false;
    const { data, error } = await sb.from('program_bookings')
      .update({ paid, updated_at: new Date().toISOString() })
      .eq('id', bid).eq('tenant_id', TID)
      .select(BOOKING_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, booking: data });
  }

  if (action === 'cancel_booking_admin') {
    const bid = String(body.booking_id ?? '');
    if (!bid) return jsonResponse({ ok: false, error: 'booking_id required' }, 400);
    const { error } = await sb.from('program_bookings')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', bid).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

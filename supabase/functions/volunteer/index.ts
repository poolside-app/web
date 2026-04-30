// =============================================================================
// volunteer — One-shot opportunities + member signup
// =============================================================================
// Public actions (no auth):
//   { action: 'list_public', slug }
//     → { ok, opportunities: [...] }      — active + upcoming, with slots_filled
//
// Member actions (member JWT):
//   { action: 'my_signups' }
//   { action: 'signup', opportunity_id, volunteer_name, member_id?, notes? }
//   { action: 'cancel_signup', signup_id }
//
// Admin actions (tenant_admin JWT):
//   { action: 'list', past? }
//   { action: 'create', title, starts_at, slots_needed, ... }
//   { action: 'update', id, ...patch }
//   { action: 'delete', id }              — soft delete (active=false)
//   { action: 'roster', opportunity_id }
//   { action: 'admin_signup', opportunity_id, household_id, volunteer_name, ... }
//   { action: 'cancel_admin', signup_id }
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

type Payload = { sub: string; kind: string; tid: string; hid?: string };
async function verifyToken(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (!p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const OPP_FIELDS = 'id, tenant_id, title, description, starts_at, ends_at, slots_needed, location, event_id, active, created_at, updated_at';
const SIGNUP_FIELDS = 'id, tenant_id, opportunity_id, household_id, member_id, volunteer_name, status, notes, created_at, updated_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function intOrDefault(v: unknown, d: number): number {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : d;
}
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function slotsFilled(sb: ReturnType<typeof createClient>, oppId: string): Promise<number> {
  const { count } = await sb.from('volunteer_signups')
    .select('id', { count: 'exact', head: true })
    .eq('opportunity_id', oppId).eq('status', 'confirmed');
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    const now = new Date().toISOString();
    const { data: opps } = await sb.from('volunteer_opportunities').select(OPP_FIELDS)
      .eq('tenant_id', tenant.id).eq('active', true)
      .gte('starts_at', now)
      .order('starts_at', { ascending: true });
    const out = await Promise.all((opps ?? []).map(async (o) => ({
      ...o, slots_filled: await slotsFilled(sb, o.id),
    })));
    return jsonResponse({ ok: true, opportunities: out });
  }

  // Auth-required
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyToken(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;
  const isMember = payload.kind === 'member';
  const isAdmin  = payload.kind === 'tenant_admin';

  // ── Member actions ──────────────────────────────────────────────────────
  if (isMember) {
    const HID = payload.hid;
    if (!HID) return jsonResponse({ ok: false, error: 'Member token missing household' }, 401);

    if (action === 'my_signups') {
      const { data: signups } = await sb.from('volunteer_signups').select(SIGNUP_FIELDS)
        .eq('tenant_id', TID).eq('household_id', HID)
        .order('created_at', { ascending: false });
      const ids = [...new Set((signups ?? []).map(s => s.opportunity_id))];
      const { data: opps } = ids.length
        ? await sb.from('volunteer_opportunities').select(OPP_FIELDS).in('id', ids).eq('tenant_id', TID)
        : { data: [] };
      const byId = new Map((opps ?? []).map(o => [o.id, o]));
      return jsonResponse({
        ok: true,
        signups: (signups ?? []).map(s => ({ ...s, opportunity: byId.get(s.opportunity_id) ?? null })),
      });
    }

    if (action === 'signup') {
      const opportunity_id = String(body.opportunity_id ?? '');
      const volunteer_name = String(body.volunteer_name ?? '').trim();
      const member_id      = strOrNull(body.member_id);
      if (!opportunity_id) return jsonResponse({ ok: false, error: 'opportunity_id required' }, 400);
      if (!volunteer_name) return jsonResponse({ ok: false, error: 'Volunteer name required' }, 400);

      const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS)
        .eq('id', opportunity_id).eq('tenant_id', TID).maybeSingle();
      if (!opp || !opp.active) return jsonResponse({ ok: false, error: 'Opportunity not found' }, 404);

      if (member_id) {
        const { data: m } = await sb.from('household_members').select('id, household_id, active')
          .eq('id', member_id).maybeSingle();
        if (!m || m.household_id !== HID || !m.active) {
          return jsonResponse({ ok: false, error: 'Member not in your household' }, 403);
        }
      }

      const filled = await slotsFilled(sb, opp.id);
      if (filled >= opp.slots_needed) {
        return jsonResponse({ ok: false, error: 'All slots are filled' }, 409);
      }

      const { data, error } = await sb.from('volunteer_signups').insert({
        tenant_id: TID, opportunity_id, household_id: HID,
        member_id: member_id || null, volunteer_name,
        notes: strOrNull(body.notes),
      }).select(SIGNUP_FIELDS).single();
      if (error) {
        if (String(error.message).toLowerCase().includes('unique')) {
          return jsonResponse({ ok: false, error: 'You already signed up for this' }, 409);
        }
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
      return jsonResponse({ ok: true, signup: data });
    }

    if (action === 'cancel_signup') {
      const sid = String(body.signup_id ?? '');
      if (!sid) return jsonResponse({ ok: false, error: 'signup_id required' }, 400);
      const { data: s } = await sb.from('volunteer_signups').select('id, household_id, status')
        .eq('id', sid).eq('tenant_id', TID).maybeSingle();
      if (!s) return jsonResponse({ ok: false, error: 'Not found' }, 404);
      if (s.household_id !== HID) return jsonResponse({ ok: false, error: 'Not yours' }, 403);
      if (s.status === 'cancelled') return jsonResponse({ ok: true });
      const { error } = await sb.from('volunteer_signups')
        .update({ status: 'cancelled', updated_at: new Date().toISOString() })
        .eq('id', sid).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: `Unknown member action: ${action}` }, 400);
  }

  // ── Admin actions ──────────────────────────────────────────────────────
  if (!isAdmin) return jsonResponse({ ok: false, error: 'Forbidden' }, 403);

  if (action === 'list') {
    let q = sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('tenant_id', TID);
    if (!body.past) q = q.gte('starts_at', new Date(Date.now() - 7 * 86400_000).toISOString());
    q = q.order('starts_at', { ascending: true });
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const out = await Promise.all((data ?? []).map(async (o) => ({
      ...o, slots_filled: await slotsFilled(sb, o.id),
    })));
    return jsonResponse({ ok: true, opportunities: out });
  }

  if (action === 'create') {
    const title = String(body.title ?? '').trim();
    if (!title) return jsonResponse({ ok: false, error: 'Title is required' }, 400);
    if (title.length > 140) return jsonResponse({ ok: false, error: 'Title too long' }, 400);
    const starts_at = isoOrNull(body.starts_at);
    if (!starts_at) return jsonResponse({ ok: false, error: 'Start time is required' }, 400);
    const ends_at = isoOrNull(body.ends_at);
    if (ends_at && new Date(ends_at) < new Date(starts_at)) {
      return jsonResponse({ ok: false, error: 'End time must be on or after start' }, 400);
    }

    const { data, error } = await sb.from('volunteer_opportunities').insert({
      tenant_id: TID, title, starts_at, ends_at,
      description: strOrNull(body.description),
      slots_needed: intOrDefault(body.slots_needed, 1),
      location: strOrNull(body.location),
      event_id: strOrNull(body.event_id),
    }).select(OPP_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, opportunity: { ...data, slots_filled: 0 } });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.title !== undefined) {
      const v = String(body.title ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Title cannot be empty' }, 400);
      if (v.length > 140) return jsonResponse({ ok: false, error: 'Title too long' }, 400);
      patch.title = v;
    }
    if (body.description  !== undefined) patch.description  = strOrNull(body.description);
    if (body.location     !== undefined) patch.location     = strOrNull(body.location);
    if (body.slots_needed !== undefined) patch.slots_needed = intOrDefault(body.slots_needed, 1);
    if (body.event_id     !== undefined) patch.event_id     = strOrNull(body.event_id);
    if (body.active       !== undefined) patch.active       = !!body.active;
    if (body.starts_at !== undefined) {
      const s = isoOrNull(body.starts_at);
      if (!s) return jsonResponse({ ok: false, error: 'Invalid starts_at' }, 400);
      patch.starts_at = s;
    }
    if (body.ends_at !== undefined) patch.ends_at = isoOrNull(body.ends_at);

    const { data, error } = await sb.from('volunteer_opportunities')
      .update(patch).eq('id', id).eq('tenant_id', TID).select(OPP_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, opportunity: { ...data, slots_filled: await slotsFilled(sb, data.id) } });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('volunteer_opportunities')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'roster') {
    const opportunity_id = String(body.opportunity_id ?? '');
    if (!opportunity_id) return jsonResponse({ ok: false, error: 'opportunity_id required' }, 400);
    const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS)
      .eq('id', opportunity_id).eq('tenant_id', TID).maybeSingle();
    if (!opp) return jsonResponse({ ok: false, error: 'Opportunity not found' }, 404);
    const { data: signups } = await sb.from('volunteer_signups').select(SIGNUP_FIELDS)
      .eq('tenant_id', TID).eq('opportunity_id', opportunity_id)
      .order('status', { ascending: true })
      .order('created_at', { ascending: true });
    const hids = [...new Set((signups ?? []).map(s => s.household_id))];
    const { data: households } = hids.length
      ? await sb.from('households').select('id, family_name').in('id', hids)
      : { data: [] };
    const byHid = new Map((households ?? []).map(h => [h.id, h.family_name]));
    return jsonResponse({
      ok: true, opportunity: opp,
      signups: (signups ?? []).map(s => ({ ...s, family_name: byHid.get(s.household_id) ?? null })),
    });
  }

  if (action === 'admin_signup') {
    const opportunity_id = String(body.opportunity_id ?? '');
    const household_id   = String(body.household_id ?? '');
    const volunteer_name = String(body.volunteer_name ?? '').trim();
    if (!opportunity_id || !household_id || !volunteer_name) {
      return jsonResponse({ ok: false, error: 'opportunity_id, household_id, volunteer_name required' }, 400);
    }
    const { data, error } = await sb.from('volunteer_signups').insert({
      tenant_id: TID, opportunity_id, household_id,
      volunteer_name, member_id: strOrNull(body.member_id),
      notes: strOrNull(body.notes),
    }).select(SIGNUP_FIELDS).single();
    if (error) {
      if (String(error.message).toLowerCase().includes('unique')) {
        return jsonResponse({ ok: false, error: 'Already signed up' }, 409);
      }
      return jsonResponse({ ok: false, error: error.message }, 500);
    }
    return jsonResponse({ ok: true, signup: data });
  }

  if (action === 'cancel_admin') {
    const sid = String(body.signup_id ?? '');
    if (!sid) return jsonResponse({ ok: false, error: 'signup_id required' }, 400);
    const { error } = await sb.from('volunteer_signups')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', sid).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

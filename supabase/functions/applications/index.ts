// =============================================================================
// applications — Public submission + admin review of membership applications
// =============================================================================
// Public actions (no auth):
//   { action: 'submit', slug, family_name, primary_name,
//     primary_email?, primary_phone?, address?, city?, zip?,
//     num_adults?, num_kids?, body? }
//     → { ok, application_id }
//
// Admin actions (tenant admin token):
//   { action: 'list', status?: 'pending'|'approved'|'rejected'|'all' }
//     → { ok, applications: [...] }
//
//   { action: 'approve', id, admin_notes?, override?: { tier?, fob_number?, paid_until_year? } }
//     → { ok, household_id }
//        // creates household + primary household_member, links them on
//        // applications.household_id, sets status='approved'.
//
//   { action: 'reject', id, admin_notes? }
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

function normalizePhoneE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^1\d{10}$/.test(digits)) return '+' + digits;
  return null;
}

const FIELDS = 'id, tenant_id, family_name, primary_name, primary_email, primary_phone, address, city, zip, num_adults, num_kids, body, status, admin_notes, decided_at, decided_by, household_id, created_at, updated_at';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── submit (no auth — anyone with the form can apply) ─────────────────
  if (action === 'submit') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants')
      .select('id, status').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.status === 'churned' || tenant.status === 'suspended') {
      return jsonResponse({ ok: false, error: 'This club isn\'t accepting applications right now' }, 403);
    }

    const family_name = String(body.family_name ?? '').trim();
    const primary_name = String(body.primary_name ?? '').trim();
    if (!family_name)  return jsonResponse({ ok: false, error: 'Family name is required' }, 400);
    if (!primary_name) return jsonResponse({ ok: false, error: 'Primary contact name is required' }, 400);

    const email = String(body.primary_email ?? '').trim().toLowerCase() || null;
    if (email && (!email.includes('@') || email.length > 200)) {
      return jsonResponse({ ok: false, error: 'Invalid email' }, 400);
    }
    const rawPhone = String(body.primary_phone ?? '').trim();
    const phone = rawPhone ? normalizePhoneE164(rawPhone) : null;
    if (rawPhone && !phone) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    if (!email && !phone)   return jsonResponse({ ok: false, error: 'Provide an email or a phone (or both)' }, 400);

    const { data, error } = await sb.from('applications').insert({
      tenant_id: tenant.id,
      family_name, primary_name,
      primary_email: email,
      primary_phone: phone,
      address: strOrNull(body.address),
      city:    strOrNull(body.city),
      zip:     strOrNull(body.zip),
      num_adults: intOrDefault(body.num_adults, 2),
      num_kids:   intOrDefault(body.num_kids, 0),
      body:    strOrNull(body.body),
    }).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, application_id: data.id });
  }

  // Admin actions below — verify tenant admin
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  if (action === 'list') {
    const status = String(body.status ?? 'pending');
    let q = sb.from('applications').select(FIELDS).eq('tenant_id', TID);
    if (status !== 'all') q = q.eq('status', status);
    const { data, error } = await q.order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, applications: data ?? [] });
  }

  if (action === 'approve') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.status !== 'pending') return jsonResponse({ ok: false, error: `Already ${app.status}` }, 409);
    if (!app.primary_phone) {
      return jsonResponse({ ok: false, error: 'Need a phone number to create the household. Edit the application or ask the family for one.' }, 400);
    }

    // Make sure the phone isn't already taken
    const { data: clash } = await sb.from('household_members')
      .select('id').eq('tenant_id', TID).eq('phone_e164', app.primary_phone).eq('active', true).maybeSingle();
    if (clash) return jsonResponse({ ok: false, error: 'Another active member already uses that phone number' }, 409);

    const ovr = (body.override ?? {}) as Record<string, unknown>;
    const tier = strOrNull(ovr.tier) ?? 'family';
    const fob_number = strOrNull(ovr.fob_number);
    const paid_until_year = ovr.paid_until_year !== undefined && ovr.paid_until_year !== ''
      ? Math.trunc(Number(ovr.paid_until_year) || 0) : null;

    // Create household
    const { data: hh, error: hhErr } = await sb.from('households').insert({
      tenant_id: TID,
      family_name: app.family_name,
      tier,
      fob_number,
      paid_until_year,
      address: app.address,
      city: app.city,
      zip: app.zip,
      active: true,
    }).select('id').single();
    if (hhErr || !hh) return jsonResponse({ ok: false, error: hhErr?.message || 'Could not create household' }, 500);

    // Create primary contact
    const { data: pm, error: pmErr } = await sb.from('household_members').insert({
      tenant_id: TID, household_id: hh.id,
      name: app.primary_name,
      phone_e164: app.primary_phone,
      email: app.primary_email,
      role: 'primary',
      can_unlock_gate: true, can_book_parties: true,
      active: true,
      confirmed_at: new Date().toISOString(),
    }).select('id').single();
    if (pmErr) {
      // Roll back the household
      await sb.from('households').delete().eq('id', hh.id);
      return jsonResponse({ ok: false, error: pmErr.message }, 500);
    }

    const decided_by = payload.synthetic ? null : payload.sub;
    await sb.from('applications').update({
      status: 'approved',
      admin_notes: strOrNull(body.admin_notes) ?? app.admin_notes,
      decided_at: new Date().toISOString(),
      decided_by,
      household_id: hh.id,
      updated_at: new Date().toISOString(),
    }).eq('id', id);

    return jsonResponse({ ok: true, household_id: hh.id, primary_id: pm.id });
  }

  if (action === 'reject') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const decided_by = payload.synthetic ? null : payload.sub;
    const { data, error } = await sb.from('applications').update({
      status: 'rejected',
      admin_notes: strOrNull(body.admin_notes),
      decided_at: new Date().toISOString(),
      decided_by,
      updated_at: new Date().toISOString(),
    }).eq('id', id).eq('tenant_id', TID).eq('status', 'pending').select(FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data)  return jsonResponse({ ok: false, error: 'Application not pending' }, 409);
    return jsonResponse({ ok: true, application: data });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

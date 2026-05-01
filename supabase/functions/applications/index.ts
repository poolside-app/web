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
function escapeHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function audit(
  sb: ReturnType<typeof createClient>,
  tenant_id: string, actor_id: string | null, actor_kind: string,
  kind: string, entity_id: string | null, summary: string,
) {
  try {
    await sb.from('audit_log').insert({
      tenant_id, kind, entity_type: 'application', entity_id,
      summary, actor_id, actor_kind, actor_label: null,
    });
  } catch { /* never break the operation */ }
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

const FIELDS = 'id, tenant_id, family_name, primary_name, primary_email, primary_phone, address, city, zip, num_adults, num_kids, body, status, admin_notes, decided_at, decided_by, household_id, payment_method, payment_status, paid_at, verified_at, verified_by, reminder_count, last_reminder_at, stripe_session_id, is_new_member, need_new_fob, prior_fob_number, alt_email, adults_json, children_json, waivers_accepted, accepted_at, signature_primary, signature_guardian, tier_slug, created_at, updated_at';

const VALID_PAYMENT_METHODS = new Set(['stripe', 'venmo']);

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

    const payment_method = strOrNull(body.payment_method);
    if (payment_method && !VALID_PAYMENT_METHODS.has(payment_method)) {
      return jsonResponse({ ok: false, error: 'Invalid payment method' }, 400);
    }

    // Full-detail fields (BE parity): adults, children, waivers, signatures
    const adultsArr   = Array.isArray(body.adults)   ? body.adults   as Array<Record<string, unknown>> : [];
    const childrenArr = Array.isArray(body.children) ? body.children as Array<Record<string, unknown>> : [];

    // Validate per-adult shape if provided. Adults must each have a name; phone normalization happens here.
    const adults_json: Array<Record<string, unknown>> = [];
    for (const a of adultsArr) {
      const nm = String(a?.name ?? '').trim();
      if (!nm) continue;  // skip empty rows from the dynamic builder
      const ap = String(a?.phone ?? '').trim();
      const apE = ap ? normalizePhoneE164(ap) : null;
      if (ap && !apE) return jsonResponse({ ok: false, error: `Invalid phone for ${nm}` }, 400);
      adults_json.push({
        name: nm,
        email: a?.email ? String(a.email).trim().toLowerCase() : null,
        phone: apE,
        signature: typeof a?.signature === 'string' ? String(a.signature).slice(0, 200000) : null,
      });
    }
    const children_json: Array<Record<string, unknown>> = [];
    for (const c of childrenArr) {
      const nm = String(c?.name ?? '').trim();
      if (!nm) continue;
      children_json.push({
        name: nm,
        dob: c?.dob ? String(c.dob) : null,
        allergies: c?.allergies ? String(c.allergies).slice(0, 500) : null,
      });
    }

    const waivers = (body.waivers_accepted ?? body.waivers ?? {}) as Record<string, unknown>;
    const waivers_accepted: Record<string, boolean> = {};
    for (const k of ['rules','guest','party','sitter','waiver']) {
      waivers_accepted[k] = waivers[k] === true;
    }
    const allWaiversAccepted = Object.values(waivers_accepted).every(Boolean);

    const sigPrimary  = typeof body.signature_primary  === 'string' ? String(body.signature_primary).slice(0, 200000)  : null;
    const sigGuardian = typeof body.signature_guardian === 'string' ? String(body.signature_guardian).slice(0, 200000) : null;

    const { data, error } = await sb.from('applications').insert({
      tenant_id: tenant.id,
      family_name, primary_name,
      primary_email: email,
      primary_phone: phone,
      address: strOrNull(body.address),
      city:    strOrNull(body.city),
      zip:     strOrNull(body.zip),
      num_adults: adults_json.length || intOrDefault(body.num_adults, 2),
      num_kids:   children_json.length || intOrDefault(body.num_kids, 0),
      body:    strOrNull(body.body),
      payment_method,
      payment_status: 'unpaid',
      is_new_member:    body.is_new_member !== false,
      need_new_fob:     body.need_new_fob === true,
      prior_fob_number: strOrNull(body.prior_fob_number),
      alt_email:        body.alt_email ? String(body.alt_email).trim().toLowerCase() : null,
      adults_json,
      children_json,
      waivers_accepted,
      accepted_at: allWaiversAccepted ? new Date().toISOString() : null,
      signature_primary:  sigPrimary,
      signature_guardian: sigGuardian,
      tier_slug: strOrNull(body.tier_slug),
    }).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await audit(sb, tenant.id, null, 'public', 'application.submit', data.id,
      `Application submitted: ${family_name} (${primary_name}, ${adults_json.length} adults / ${children_json.length} kids)`);
    // Enqueue an admin task — both membership chair and treasurer
    // (treasurer cares because the app declares a payment method).
    try {
      await sb.from('admin_tasks').insert({
        tenant_id: tenant.id,
        target_scopes: ['applications'],
        kind: 'application.submitted',
        summary: `New application: ${family_name} (${primary_name})`,
        link_url: '/club/admin/members.html#applications',
        source_kind: 'application', source_id: data.id,
      });
    } catch { /* best-effort — never fails submission */ }
    return jsonResponse({ ok: true, application_id: data.id, payment_method });
  }

  // ── claim_venmo_paid (member-side: "I paid via Venmo") ─────────────────
  // Public action — anyone with the application id can flag it. We dedupe
  // on (source_id, kind) so multiple taps don't multi-notify the treasurer.
  if (action === 'claim_venmo_paid') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, family_name, primary_name, payment_status, status')
      .eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') {
      return jsonResponse({ ok: false, error: 'Already marked paid — no action needed' }, 409);
    }
    // Dedupe: don't add a second open claim for the same app
    const { data: existing } = await sb.from('admin_tasks')
      .select('id').eq('tenant_id', app.tenant_id).eq('source_kind', 'application')
      .eq('source_id', app.id).eq('kind', 'venmo.claim')
      .is('completed_at', null).is('dismissed_at', null).maybeSingle();
    if (existing) return jsonResponse({ ok: true, deduped: true });
    await sb.from('admin_tasks').insert({
      tenant_id: app.tenant_id,
      target_scopes: ['payments', 'applications'],
      kind: 'venmo.claim',
      summary: `${app.family_name}: ${app.primary_name} reports paid via Venmo — verify`,
      link_url: '/club/admin/payments.html',
      source_kind: 'application', source_id: app.id,
    });
    await audit(sb, app.tenant_id, null, 'public', 'application.venmo_claim', app.id,
      `${app.family_name} claimed Venmo payment`);
    return jsonResponse({ ok: true });
  }

  // Admin actions below — verify tenant admin
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  if (action === 'list') {
    const status = String(body.status ?? 'pending');
    const filter = String(body.filter ?? '');  // 'unpaid' | 'overdue' | ''
    let q = sb.from('applications').select(FIELDS).eq('tenant_id', TID);
    if (status !== 'all') q = q.eq('status', status);
    if (filter === 'unpaid')  q = q.in('payment_status', ['unpaid', 'pending']);
    if (filter === 'overdue') {
      // approved + still unpaid + decided more than 10 days ago
      const tenDaysAgo = new Date(Date.now() - 10 * 86400_000).toISOString();
      q = q.eq('status', 'approved').in('payment_status', ['unpaid','pending']).lt('decided_at', tenDaysAgo);
    }
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
    // Tier resolution order: admin override > applicant's selected tier > 'family' default
    const tier = strOrNull(ovr.tier) ?? strOrNull(app.tier_slug) ?? 'family';
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

    // ── Populate the rest of the family from adults_json + children_json ──
    // Skip adults_json[0] when its name matches primary_name (avoid duplicate).
    const adults = Array.isArray(app.adults_json) ? app.adults_json as Array<Record<string, unknown>> : [];
    const children = Array.isArray(app.children_json) ? app.children_json as Array<Record<string, unknown>> : [];

    // Normalize whatever the apply form's formatPhoneInput rendered (e.g.
    // "(555) 123-4567") into E.164 so future SMS magic-link lookups can match.
    function toE164(raw: string | null | undefined): string | null {
      if (!raw) return null;
      const digits = String(raw).replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) return digits;
      if (/^\d{10}$/.test(digits)) return '+1' + digits;
      if (/^1\d{10}$/.test(digits)) return '+' + digits;
      return null;
    }

    let createdExtraMembers = 0;
    for (let i = 0; i < adults.length; i++) {
      const a = adults[i];
      const aName = String(a?.name ?? '').trim();
      if (!aName) continue;
      // First adult is the primary already inserted — skip if it matches
      if (i === 0 && aName.toLowerCase() === String(app.primary_name).trim().toLowerCase()) continue;
      const aPhone = toE164(a?.phone);
      // Skip if phone clashes with primary's phone (safety)
      if (aPhone && aPhone === app.primary_phone) continue;
      const { error: spErr } = await sb.from('household_members').insert({
        tenant_id: TID, household_id: hh.id,
        name: aName,
        phone_e164: aPhone,
        email: a?.email ? String(a.email).toLowerCase() : null,
        role: 'adult',
        can_unlock_gate: true, can_book_parties: false,
        active: true,
        confirmed_at: new Date().toISOString(),
      });
      if (!spErr) createdExtraMembers++;
    }
    for (const c of children) {
      const cName = String(c?.name ?? '').trim();
      if (!cName) continue;
      // Determine role by DOB if provided (teen >= 13)
      let role = 'child';
      if (c?.dob) {
        const yrs = (Date.now() - new Date(String(c.dob)).getTime()) / (365.25 * 86400_000);
        if (yrs >= 13) role = 'teen';
      }
      const { error: chErr } = await sb.from('household_members').insert({
        tenant_id: TID, household_id: hh.id,
        name: cName,
        role,
        can_unlock_gate: role === 'teen',
        can_book_parties: false,
        active: true,
        confirmed_at: new Date().toISOString(),
      });
      if (!chErr) createdExtraMembers++;
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

    // ── Welcome email + magic-link token ────────────────────────────────
    // Generate a member_magic_links row so the family can sign in
    // immediately without the magic-link request dance.
    let welcome_dev_link: string | null = null;
    let welcome_sent = false;
    if (app.primary_email) {
      const tok = randomToken();
      const tokHash = await sha256Hex(tok);
      const expIso = new Date(Date.now() + 60 * 60 * 24 * 1000 * 7).toISOString();  // 7 days
      await sb.from('member_magic_links').insert({
        tenant_id: TID, member_id: pm.id,
        token_hash: tokHash, expires_at: expIso,
      });

      const { data: tenant } = await sb.from('tenants')
        .select('display_name, slug').eq('id', TID).maybeSingle();
      const clubName = tenant?.display_name || 'Your club';
      const clubUrl  = tenant ? `https://${tenant.slug}.poolsideapp.com` : '';
      const verifyLink = `${clubUrl}/m/verify.html#token=${encodeURIComponent(tok)}`;

      const { data: settingsRow } = await sb.from('settings')
        .select('value').eq('tenant_id', TID).maybeSingle();
      const venmo = ((settingsRow?.value as Record<string, unknown> | null)?.payments as Record<string, unknown> | undefined)?.venmo_handle;

      const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
      const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'Poolside <onboarding@resend.dev>';

      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
          <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to ${escapeHtml(clubName)}!</h2>
          <p style="margin:0 0 16px;color:#64748b">Hi ${escapeHtml(app.primary_name)} — your application was approved. Click below to sign in to your member dashboard.</p>
          <p style="margin:24px 0">
            <a href="${verifyLink}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to ${escapeHtml(clubName)}</a>
          </p>
          ${app.payment_status !== 'paid' ? `
            <h3 style="font-family:Georgia,serif;color:#0a3b5c;margin:24px 0 6px;font-size:16px">Final step: dues</h3>
            <p style="margin:0 0 8px;color:#64748b">${app.payment_method === 'venmo' && venmo
              ? `Send your annual dues via Venmo to <b>@${escapeHtml(String(venmo))}</b>. We'll mark your account as paid once we confirm the payment.`
              : 'A board member will reach out shortly with payment details.'}</p>
          ` : ''}
          <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0">
          <p style="margin:0;color:#94a3b8;font-size:12px">Sign-in link is good for one use and expires in 7 days. If it expires, ask for a fresh one at <a href="${clubUrl}/m/login.html" style="color:#0a3b5c">${escapeHtml(clubUrl.replace(/^https?:\/\//, ''))}/m/login.html</a>.</p>
        </div>
      `;

      if (RESEND_API_KEY) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: RESEND_FROM, to: [app.primary_email],
              subject: `Welcome to ${clubName}!`, html,
            }),
          });
          welcome_sent = r.ok;
        } catch { /* fall through to dev mode */ }
      }
      if (!welcome_sent) welcome_dev_link = verifyLink;

      await sb.from('application_actions').insert({
        application_id: id, tenant_id: TID,
        kind: 'welcome_sent',
        body: welcome_sent ? 'email via Resend' : 'dev mode (link returned)',
        actor_id: decided_by,
      });
    }

    await audit(sb, TID, decided_by, 'tenant_admin', 'application.approve', id,
      `Approved ${app.family_name}; household + ${1 + createdExtraMembers} member${createdExtraMembers === 0 ? '' : 's'} created`);

    // Close the "review application" task that was opened on submit.
    await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: decided_by })
      .eq('tenant_id', TID).eq('source_kind', 'application').eq('source_id', id)
      .eq('kind', 'application.submitted')
      .is('completed_at', null);

    return jsonResponse({
      ok: true,
      household_id: hh.id, primary_id: pm.id,
      members_created: 1 + createdExtraMembers,
      welcome_sent, welcome_dev_link,
    });
  }

  // ── verify_payment (manual, used for Venmo flow) ──────────────────────
  // Membership coordinator clicks "Verify Venmo" — flips application to
  // paid AND flips household.dues_paid_for_year=true. Stamps verified_at /
  // verified_by for audit. Idempotent — safe to call twice.
  if (action === 'verify_payment') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const method = strOrNull(body.method) ?? 'venmo';

    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.status !== 'approved') {
      return jsonResponse({ ok: false, error: 'Approve the application first' }, 409);
    }

    const verified_by = payload.synthetic ? null : payload.sub;
    const now = new Date().toISOString();
    const { error: updErr } = await sb.from('applications').update({
      payment_status: 'paid',
      payment_method: method,
      paid_at: now,
      verified_at: now,
      verified_by,
      updated_at: now,
    }).eq('id', id).eq('tenant_id', TID);
    if (updErr) return jsonResponse({ ok: false, error: updErr.message }, 500);

    // Flip the household's dues flag
    if (app.household_id) {
      await sb.from('households').update({
        dues_paid_for_year: true,
        paid_until_year: new Date().getFullYear(),
      }).eq('id', app.household_id).eq('tenant_id', TID);
    }

    // Audit log (per-application)
    await sb.from('application_actions').insert({
      application_id: id, tenant_id: TID,
      kind: method === 'stripe' ? 'stripe_paid' : 'venmo_verified',
      body: strOrNull(body.note) ?? null,
      actor_id: verified_by,
    });
    // Audit log (tenant-wide)
    await audit(sb, TID, verified_by, 'tenant_admin', 'application.verify_payment', id,
      `Verified ${method} payment for ${app.family_name}`);

    // Close any related open Venmo-claim or application-submitted tasks.
    await sb.from('admin_tasks')
      .update({ completed_at: now, completed_by: verified_by })
      .eq('tenant_id', TID).eq('source_kind', 'application').eq('source_id', id)
      .is('completed_at', null);

    return jsonResponse({ ok: true });
  }

  // ── send_reminder ─────────────────────────────────────────────────────
  // Records the reminder + bumps the counter. The actual email/SMS is
  // wired to whatever notification infra is configured (Resend if keys
  // are set, else dev_link in the response so admin can copy-paste).
  if (action === 'send_reminder') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: app } = await sb.from('applications').select(FIELDS)
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') {
      return jsonResponse({ ok: false, error: 'Already paid — no reminder needed' }, 409);
    }
    if (!app.primary_email && !app.primary_phone) {
      return jsonResponse({ ok: false, error: 'Application has no contact info to remind' }, 400);
    }

    // Try Resend if a key exists; fall back to "dev mode" return.
    const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
    const RESEND_FROM    = Deno.env.get('RESEND_FROM') || 'Poolside <onboarding@resend.dev>';
    const { data: tenant } = await sb.from('tenants')
      .select('display_name, slug').eq('id', TID).maybeSingle();
    const clubName = tenant?.display_name || 'Your club';
    const clubUrl  = tenant ? `https://${tenant.slug}.poolsideapp.com` : '';
    let sent = false;
    let dev_link: string | null = null;

    if (RESEND_API_KEY && app.primary_email) {
      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
          <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Friendly reminder from ${clubName}</h2>
          <p style="margin:0 0 14px;color:#64748b">Hi ${escapeHtml(app.primary_name)} — your application to ${escapeHtml(clubName)} was approved, but we haven't received your dues payment yet.</p>
          <p style="margin:0 0 14px;color:#64748b">Please send your dues to complete the membership and we'll get your account fully active.</p>
          <p style="margin:24px 0">
            <a href="${clubUrl}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Visit ${escapeHtml(clubName)}</a>
          </p>
          <p style="margin:0;color:#94a3b8;font-size:12px">This is automated — reply to this email if you have questions.</p>
        </div>
      `;
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: RESEND_FROM,
            to: [app.primary_email],
            subject: `Reminder: dues for ${clubName}`,
            html,
          }),
        });
        sent = res.ok;
      } catch { /* fall through to dev mode */ }
    }
    if (!sent) {
      dev_link = `mailto:${app.primary_email ?? ''}?subject=${encodeURIComponent(`Reminder: dues for ${clubName}`)}&body=${encodeURIComponent(`Hi ${app.primary_name},\n\nYour application to ${clubName} was approved, but we haven't received your dues payment yet. Please send your dues to complete your membership.\n\n${clubUrl}\n`)}`;
    }

    const now = new Date().toISOString();
    await sb.from('applications').update({
      reminder_count: (app.reminder_count ?? 0) + 1,
      last_reminder_at: now,
      updated_at: now,
    }).eq('id', id).eq('tenant_id', TID);

    await sb.from('application_actions').insert({
      application_id: id, tenant_id: TID,
      kind: 'reminder_sent',
      body: sent ? 'email via Resend' : 'dev mode (mailto link returned)',
      actor_id: payload.synthetic ? null : payload.sub,
    });

    return jsonResponse({ ok: true, sent, dev_link });
  }

  // ── log (audit trail viewer) ──────────────────────────────────────────
  if (action === 'log') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data, error } = await sb.from('application_actions')
      .select('id, kind, body, actor_id, created_at')
      .eq('application_id', id).eq('tenant_id', TID)
      .order('created_at', { ascending: false }).limit(50);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, log: data ?? [] });
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

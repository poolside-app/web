// =============================================================================
// member_auth — Email magic-link login for tenant members
// =============================================================================
// Public, no auth required for `start` and `verify`; `me` requires a member
// JWT (kind='member', signed with ADMIN_JWT_SECRET so we don't manage another
// secret).
//
// Actions:
//   { action: 'start', slug, email }
//     → { ok, sent: true, message: '...' }
//        or { ok, sent: false, dev_link: '...' } if RESEND_API_KEY is unset
//
//   { action: 'verify', slug, token }
//     → { ok, token, user, household, tenant }
//
//   { action: 'me' }                      [Authorization: Bearer <member jwt>]
//     → { ok, user, household, tenant }
//
//   { action: 'logout' }                  → { ok }   (stateless on the server)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, verify, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET      = Deno.env.get('ADMIN_JWT_SECRET');
const RESEND_API_KEY  = Deno.env.get('RESEND_API_KEY');
// Default to Resend's onboarding sender so things work pre-domain-verification.
const RESEND_FROM     = Deno.env.get('RESEND_FROM') || 'Poolside <onboarding@resend.dev>';

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

async function getKey(): Promise<CryptoKey> {
  if (!JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

function randomToken(): string {
  // 32 random bytes → URL-safe base64 (no padding). ~43 chars.
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]!));
}

// Twilio SMS sender — returns { sent, error? } so callers can fall back
// to a dev_link when keys aren't set.
async function sendMagicLinkSms(args: { to: string; tenantName: string; verifyLink: string }): Promise<{ sent: boolean; error?: string }> {
  const sid    = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token  = Deno.env.get('TWILIO_AUTH_TOKEN');
  const fromN  = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !token || !fromN) return { sent: false, error: 'TWILIO_* env vars not set' };
  const body = `Sign in to ${args.tenantName}: ${args.verifyLink}\n(Link expires in 15 minutes.)`;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: args.to, From: fromN, Body: body }).toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { sent: false, error: `Twilio ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

async function sendMagicLinkEmail(args: {
  to: string; tenantName: string; clubUrl: string; verifyLink: string; memberName: string;
}): Promise<{ sent: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not set' };
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Sign in to ${escapeHtml(args.tenantName)}</h2>
      <p style="margin:0 0 16px;color:#64748b">Hi ${escapeHtml(args.memberName || 'there')}, click below to sign in. The link is good for one use and expires in 15 minutes.</p>
      <p style="margin:24px 0">
        <a href="${args.verifyLink}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to ${escapeHtml(args.tenantName)}</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.5">If the button doesn't work, copy this link into your browser:<br><code style="font-size:12px;word-break:break-all;color:#0a3b5c">${args.verifyLink}</code></p>
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0">
      <p style="margin:0;color:#94a3b8;font-size:12px">You're receiving this because someone (probably you) requested a sign-in link for <a href="${args.clubUrl}" style="color:#0a3b5c">${escapeHtml(args.clubUrl.replace(/^https?:\/\//, ''))}</a>. Didn't request it? You can ignore this email.</p>
    </div>
  `;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [args.to],
        subject: `Sign in to ${args.tenantName}`,
        html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { sent: false, error: `Resend ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── start ──────────────────────────────────────────────────────────────
  // Accepts EITHER an email or an E.164 phone number. If email → sends a
  // magic link via Resend. If phone → sends a one-tap sign-in link via SMS
  // (Twilio). When the relevant provider has no key configured, returns
  // dev_link so testing without infra still works.
  if (action === 'start') {
    const slug  = String(body.slug ?? '').trim().toLowerCase();
    const raw   = String(body.email ?? body.phone ?? body.identifier ?? '').trim();
    if (!slug || !raw) {
      return jsonResponse({ ok: false, error: 'A valid club slug and email or phone are required' }, 400);
    }
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, status')
      .eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.status === 'churned') {
      return jsonResponse({ ok: false, error: 'This club is no longer active' }, 403);
    }

    // Detect input shape: phone vs email. Strip non-digits to check phone-ness.
    const looksLikePhone = !raw.includes('@') && raw.replace(/[^\d]/g, '').length >= 7;
    let phone_e164: string | null = null;
    let email: string | null = null;
    if (looksLikePhone) {
      const digits = raw.replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) phone_e164 = digits;
      else if (/^\d{10}$/.test(digits)) phone_e164 = '+1' + digits;
      else if (/^1\d{10}$/.test(digits)) phone_e164 = '+' + digits;
      if (!phone_e164) return jsonResponse({ ok: false, error: 'That phone number doesn\'t look right' }, 400);
    } else {
      email = raw.toLowerCase();
      if (!email.includes('@')) return jsonResponse({ ok: false, error: 'Invalid email address' }, 400);
    }

    const generic = { ok: true, sent: true, message: phone_e164
      ? 'If your number is on file, a sign-in text is on the way.'
      : 'If your email is on file, a sign-in link is on the way.' };

    let memberQuery = sb.from('household_members')
      .select('id, name, email, phone_e164, household_id, active')
      .eq('tenant_id', tenant.id).eq('active', true);
    if (phone_e164) memberQuery = memberQuery.eq('phone_e164', phone_e164);
    else memberQuery = memberQuery.ilike('email', email!);
    const { data: member } = await memberQuery.maybeSingle();

    if (!member) {
      await new Promise(r => setTimeout(r, 250));
      return jsonResponse(generic);
    }

    const tok = randomToken();
    const tokenHash = await sha256Hex(tok);
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
    await sb.from('member_magic_links').insert({
      tenant_id: tenant.id, member_id: member.id,
      token_hash: tokenHash, expires_at: expiresAt,
    });

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const verifyLink = `${clubUrl}/m/verify.html#token=${encodeURIComponent(tok)}`;

    if (phone_e164) {
      const send = await sendMagicLinkSms({
        to: phone_e164, tenantName: tenant.display_name, verifyLink,
      });
      // Auth-category SMS — uncapped per project_sms_caps memory, but
      // logged for audit + visibility in admin dashboards.
      await sb.from('sms_log').insert({
        tenant_id: tenant.id, category: 'auth', to_phone: phone_e164,
        success: send.sent, error: send.error ?? null, source: 'member_auth.start',
      });
      if (send.sent) return jsonResponse(generic);
      return jsonResponse({
        ok: true, sent: false,
        message: 'SMS sending is not configured. Use the link below to sign in.',
        dev_link: verifyLink, dev_error: send.error,
      });
    }

    const send = await sendMagicLinkEmail({
      to: member.email!, tenantName: tenant.display_name,
      clubUrl, verifyLink, memberName: member.name,
    });
    if (send.sent) return jsonResponse(generic);
    return jsonResponse({
      ok: true, sent: false,
      message: 'Email sending is not configured. Use the link below to sign in.',
      dev_link: verifyLink, dev_error: send.error,
    });
  }

  // ── verify ─────────────────────────────────────────────────────────────
  if (action === 'verify') {
    const slug  = String(body.slug ?? '').trim().toLowerCase();
    const token = String(body.token ?? '').trim();
    if (!token) return jsonResponse({ ok: false, error: 'token required' }, 400);

    const tokenHash = await sha256Hex(token);
    const { data: link } = await sb.from('member_magic_links')
      .select('id, tenant_id, member_id, expires_at, used_at')
      .eq('token_hash', tokenHash)
      .maybeSingle();
    if (!link)              return jsonResponse({ ok: false, error: 'Invalid or expired link' }, 401);
    if (link.used_at)       return jsonResponse({ ok: false, error: 'This sign-in link has already been used' }, 401);
    if (new Date(link.expires_at) < new Date()) {
      return jsonResponse({ ok: false, error: 'This sign-in link has expired' }, 401);
    }

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name').eq('id', link.tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);
    if (slug && slug !== tenant.slug) {
      return jsonResponse({ ok: false, error: 'Link does not match this club' }, 401);
    }

    const { data: member } = await sb.from('household_members')
      .select('id, name, email, phone_e164, role, household_id, can_unlock_gate, can_book_parties, active')
      .eq('id', link.member_id).maybeSingle();
    if (!member || !member.active) {
      return jsonResponse({ ok: false, error: 'Your member record is no longer active' }, 401);
    }

    // Burn the link and bump last_seen_at on the member.
    const now = new Date().toISOString();
    await sb.from('member_magic_links').update({ used_at: now }).eq('id', link.id);
    await sb.from('household_members').update({
      last_seen_at: now,
      confirmed_at: now,
    }).eq('id', member.id);

    const key = await getKey();
    const jwt = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub: member.id, kind: 'member',
        tid: tenant.id, slug: tenant.slug, hid: member.household_id,
        exp: getNumericDate(60 * 60 * 24 * 30),  // 30 days
      },
      key,
    );
    return jsonResponse({
      ok: true,
      token: jwt,
      user: {
        id: member.id, name: member.name, email: member.email,
        phone_e164: member.phone_e164, role: member.role,
        can_unlock_gate: member.can_unlock_gate,
        can_book_parties: member.can_book_parties,
      },
      household: { id: member.household_id },
      tenant: { slug: tenant.slug, display_name: tenant.display_name },
    });
  }

  // For me / logout we need a valid member token.
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  let payload: Record<string, unknown> | null = null;
  if (tokRaw) {
    try {
      const key = await getKey();
      const p = await verify(tokRaw, key) as Record<string, unknown>;
      if (p.kind === 'member' && p.sub && p.tid && p.hid) payload = p;
    } catch { /* leave as null */ }
  }
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // ── me ─────────────────────────────────────────────────────────────────
  if (action === 'me') {
    const [{ data: member }, { data: tenant }, { data: household }, { data: housemates }] = await Promise.all([
      sb.from('household_members')
        .select('id, name, email, phone_e164, role, household_id, can_unlock_gate, can_book_parties, directory_visible, active')
        .eq('id', payload.sub as string).maybeSingle(),
      sb.from('tenants')
        .select('slug, display_name, status')
        .eq('id', payload.tid as string).maybeSingle(),
      sb.from('households')
        .select('id, family_name, tier, fob_number, dues_paid_for_year, paid_until_year, address, city, zip, emergency_contact, active')
        .eq('id', payload.hid as string).maybeSingle(),
      sb.from('household_members')
        .select('id, name, role, phone_e164, email, directory_visible, active')
        .eq('household_id', payload.hid as string).eq('active', true)
        .order('role', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);
    if (!member || !member.active) return jsonResponse({ ok: false, error: 'Member not found' }, 401);
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 401);
    if (!household || !household.active) return jsonResponse({ ok: false, error: 'Household not active' }, 401);

    // Members see public + members-visibility documents
    const { data: docs } = await sb.from('documents')
      .select('id, title, description, url, visibility, sort_order')
      .eq('tenant_id', payload.tid as string)
      .eq('active', true)
      .in('visibility', ['public', 'members'])
      .order('sort_order', { ascending: true })
      .order('created_at', { ascending: false })
      .limit(50);

    return jsonResponse({
      ok: true,
      user: member,
      tenant,
      household: { ...household, members: housemates ?? [] },
      documents: docs ?? [],
    });
  }

  // ── list_my_parties ────────────────────────────────────────────────────
  if (action === 'list_my_parties') {
    const { data, error } = await sb.from('party_bookings')
      .select('id, title, body, starts_at, ends_at, expected_guests, location, status, admin_notes, decided_at, event_id, created_at')
      .eq('tenant_id', payload.tid as string)
      .eq('household_id', payload.hid as string)
      .order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, parties: data ?? [] });
  }

  // ── request_party ──────────────────────────────────────────────────────
  if (action === 'request_party') {
    // Verify the requesting member can_book_parties before accepting.
    const { data: member } = await sb.from('household_members')
      .select('id, can_book_parties, household_id, active')
      .eq('id', payload.sub as string).maybeSingle();
    if (!member || !member.active) {
      return jsonResponse({ ok: false, error: 'Member not found' }, 401);
    }
    if (!member.can_book_parties) {
      return jsonResponse({ ok: false, error: 'Your household admin hasn\'t given you party-booking access' }, 403);
    }

    const title = String((body as Record<string, unknown>).title ?? '').trim();
    const startsAtRaw = String((body as Record<string, unknown>).starts_at ?? '').trim();
    if (!title) return jsonResponse({ ok: false, error: 'Title is required' }, 400);
    if (title.length > 140) return jsonResponse({ ok: false, error: 'Title too long' }, 400);
    if (!startsAtRaw) return jsonResponse({ ok: false, error: 'Date / time is required' }, 400);
    const startsDate = new Date(startsAtRaw);
    if (isNaN(startsDate.getTime())) return jsonResponse({ ok: false, error: 'Invalid date/time' }, 400);
    if (startsDate < new Date()) {
      return jsonResponse({ ok: false, error: 'Pick a date in the future' }, 400);
    }
    const endsAtRaw = (body as Record<string, unknown>).ends_at;
    let endsAt: string | null = null;
    if (endsAtRaw) {
      const e = new Date(String(endsAtRaw));
      if (isNaN(e.getTime())) return jsonResponse({ ok: false, error: 'Invalid end time' }, 400);
      if (e < startsDate) return jsonResponse({ ok: false, error: 'End time must be after start' }, 400);
      endsAt = e.toISOString();
    }
    const guests = (body as Record<string, unknown>).expected_guests;
    const expected_guests = guests === undefined || guests === null || guests === ''
      ? null
      : Math.max(0, Math.trunc(Number(guests) || 0));

    const bodyText = String((body as Record<string, unknown>).body ?? '').trim();
    if (bodyText.length > 2000) return jsonResponse({ ok: false, error: 'Notes too long' }, 400);

    const { data, error } = await sb.from('party_bookings').insert({
      tenant_id: payload.tid as string,
      household_id: member.household_id,
      requested_by: member.id,
      title,
      body: bodyText || null,
      starts_at: startsDate.toISOString(),
      ends_at: endsAt,
      expected_guests,
      status: 'pending',
    }).select('id, title, starts_at, ends_at, status, created_at').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, party: data });
  }

  // ── cancel_my_party ────────────────────────────────────────────────────
  if (action === 'cancel_my_party') {
    const id = String((body as Record<string, unknown>).id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: bk } = await sb.from('party_bookings')
      .select('id, status, event_id, household_id')
      .eq('id', id).eq('tenant_id', payload.tid as string).maybeSingle();
    if (!bk) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    if (bk.household_id !== payload.hid) return jsonResponse({ ok: false, error: 'Not yours' }, 403);
    if (bk.status === 'cancelled') return jsonResponse({ ok: true });
    // Members can cancel pending OR approved (life happens). Admin-cancelled
    // ones can't be re-cancelled.
    if (!['pending','approved'].includes(bk.status as string)) {
      return jsonResponse({ ok: false, error: `Cannot cancel — status is ${bk.status}` }, 409);
    }
    await sb.from('party_bookings').update({
      status: 'cancelled', updated_at: new Date().toISOString(),
    }).eq('id', id);
    if (bk.event_id) {
      await sb.from('events').update({
        active: false, updated_at: new Date().toISOString(),
      }).eq('id', bk.event_id);
    }
    return jsonResponse({ ok: true });
  }

  // ── update_my_profile ──────────────────────────────────────────────────
  // Members can edit their own name/email/phone. Other fields (role,
  // permissions, household_id) stay admin-controlled.
  if (action === 'update_my_profile') {
    const patch: Record<string, unknown> = { last_seen_at: new Date().toISOString() };
    const b = body as Record<string, unknown>;
    if (b.name !== undefined) {
      const v = String(b.name).trim();
      if (!v) return jsonResponse({ ok: false, error: 'Name cannot be empty' }, 400);
      patch.name = v;
    }
    if (b.email !== undefined) {
      const v = String(b.email).trim().toLowerCase();
      if (v && !v.includes('@')) return jsonResponse({ ok: false, error: 'Invalid email' }, 400);
      patch.email = v || null;
    }
    if (b.phone_e164 !== undefined) {
      const raw = String(b.phone_e164 ?? '').trim();
      if (!raw) {
        patch.phone_e164 = null;
      } else {
        const digits = raw.replace(/[^\d+]/g, '');
        let norm: string | null = null;
        if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) norm = digits;
        else if (/^\d{10}$/.test(digits)) norm = '+1' + digits;
        else if (/^1\d{10}$/.test(digits)) norm = '+' + digits;
        if (!norm) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);

        // Make sure another active member doesn't already use this number
        const { data: clash } = await sb.from('household_members')
          .select('id').eq('tenant_id', payload.tid as string).eq('phone_e164', norm)
          .eq('active', true).neq('id', payload.sub as string).maybeSingle();
        if (clash) return jsonResponse({ ok: false, error: 'Phone number already in use' }, 409);
        patch.phone_e164 = norm;
      }
    }
    if (b.directory_visible !== undefined) patch.directory_visible = !!b.directory_visible;
    if (Object.keys(patch).length === 1) return jsonResponse({ ok: true, noop: true });
    const { error } = await sb.from('household_members')
      .update(patch).eq('id', payload.sub as string);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  // ── Household management (primary contact only) ───────────────────────
  // Primaries can manage their own household roster without going through
  // an admin. The JWT carries hid (household id) — never trust the client
  // to specify that.
  async function requirePrimary() {
    const { data: me } = await sb.from('household_members')
      .select('id, role, household_id, active')
      .eq('id', payload.sub as string).maybeSingle();
    if (!me || !me.active) return { error: 'Member not found', code: 401 };
    if (me.role !== 'primary') return { error: 'Only the primary contact can manage household members', code: 403 };
    if (me.household_id !== payload.hid) return { error: 'Household mismatch', code: 403 };
    return { me };
  }

  if (action === 'add_household_member') {
    const r = await requirePrimary();
    if ('error' in r && r.error) return jsonResponse({ ok: false, error: r.error }, r.code);

    const b = body as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    const role = String(b.role ?? '').trim();
    if (!name) return jsonResponse({ ok: false, error: 'Name required' }, 400);
    if (!['adult','teen','child'].includes(role)) {
      return jsonResponse({ ok: false, error: 'Role must be adult, teen, or child' }, 400);
    }

    const phoneRaw = String(b.phone_e164 ?? '').trim();
    let phone: string | null = null;
    if (phoneRaw) {
      const digits = phoneRaw.replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) phone = digits;
      else if (/^\d{10}$/.test(digits)) phone = '+1' + digits;
      else if (/^1\d{10}$/.test(digits)) phone = '+' + digits;
      else return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    } else if (role !== 'child') {
      return jsonResponse({ ok: false, error: 'Phone required for adults and teens' }, 400);
    }
    if (phone) {
      const { data: clash } = await sb.from('household_members')
        .select('id').eq('tenant_id', payload.tid as string).eq('phone_e164', phone)
        .eq('active', true).maybeSingle();
      if (clash) return jsonResponse({ ok: false, error: 'Phone number already in use' }, 409);
    }

    const { data: ins, error } = await sb.from('household_members').insert({
      tenant_id: payload.tid as string,
      household_id: payload.hid as string,
      name, phone_e164: phone,
      email: typeof b.email === 'string' && b.email ? String(b.email).trim().toLowerCase() : null,
      role,
      can_unlock_gate: b.can_unlock_gate !== false,
      can_book_parties: b.can_book_parties === true,
      active: true,
      confirmed_at: new Date().toISOString(),
      added_by: payload.sub as string,
    }).select('id').single();
    if (error) {
      const msg = /household_member_cap/.test(error.message)
        ? 'Household is at its 8-person limit' : error.message;
      return jsonResponse({ ok: false, error: msg }, 400);
    }
    // Audit log
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid as string,
        kind: 'household_member.add', entity_type: 'household_member', entity_id: ins.id,
        summary: `Primary added ${name} to their household`,
        actor_id: payload.sub as string, actor_kind: 'member',
      });
    } catch { /* ignore */ }
    return jsonResponse({ ok: true, member_id: ins.id });
  }

  if (action === 'remove_household_member') {
    const r = await requirePrimary();
    if ('error' in r && r.error) return jsonResponse({ ok: false, error: r.error }, r.code);

    const id = String((body as Record<string, unknown>).id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: target } = await sb.from('household_members')
      .select('id, role, name, household_id').eq('id', id).maybeSingle();
    if (!target) return jsonResponse({ ok: false, error: 'Member not found' }, 404);
    if (target.household_id !== payload.hid) return jsonResponse({ ok: false, error: 'Not your household' }, 403);
    if (target.role === 'primary') {
      return jsonResponse({ ok: false, error: 'Primary contact can\'t remove themselves; ask the club admin instead' }, 400);
    }
    const { error } = await sb.from('household_members')
      .update({ active: false }).eq('id', id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('member_sessions').delete().eq('member_id', id);
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid as string,
        kind: 'household_member.remove', entity_type: 'household_member', entity_id: id,
        summary: `Primary removed ${target.name} from their household`,
        actor_id: payload.sub as string, actor_kind: 'member',
      });
    } catch { /* ignore */ }
    return jsonResponse({ ok: true });
  }

  if (action === 'update_household_member') {
    const r = await requirePrimary();
    if ('error' in r && r.error) return jsonResponse({ ok: false, error: r.error }, r.code);

    const b = body as Record<string, unknown>;
    const id = String(b.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: target } = await sb.from('household_members')
      .select('id, role, household_id, phone_e164').eq('id', id).maybeSingle();
    if (!target) return jsonResponse({ ok: false, error: 'Member not found' }, 404);
    if (target.household_id !== payload.hid) return jsonResponse({ ok: false, error: 'Not your household' }, 403);

    const patch: Record<string, unknown> = {};
    if (b.name !== undefined) {
      const v = String(b.name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Name cannot be empty' }, 400);
      patch.name = v;
    }
    if (b.email !== undefined) {
      const v = String(b.email ?? '').trim().toLowerCase();
      patch.email = v || null;
    }
    if (b.phone_e164 !== undefined) {
      const raw = String(b.phone_e164 ?? '').trim();
      if (!raw) {
        if (target.role === 'primary') return jsonResponse({ ok: false, error: 'Primary must have a phone' }, 400);
        patch.phone_e164 = null;
      } else {
        const digits = raw.replace(/[^\d+]/g, '');
        let norm: string | null = null;
        if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) norm = digits;
        else if (/^\d{10}$/.test(digits)) norm = '+1' + digits;
        else if (/^1\d{10}$/.test(digits)) norm = '+' + digits;
        if (!norm) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
        if (norm !== target.phone_e164) {
          const { data: clash } = await sb.from('household_members')
            .select('id').eq('tenant_id', payload.tid as string).eq('phone_e164', norm)
            .eq('active', true).neq('id', id).maybeSingle();
          if (clash) return jsonResponse({ ok: false, error: 'Phone number already in use' }, 409);
        }
        patch.phone_e164 = norm;
      }
    }
    if (b.can_unlock_gate  !== undefined) patch.can_unlock_gate  = !!b.can_unlock_gate;
    if (b.can_book_parties !== undefined) patch.can_book_parties = !!b.can_book_parties;
    if (b.directory_visible !== undefined) patch.directory_visible = !!b.directory_visible;
    if (Object.keys(patch).length === 0) return jsonResponse({ ok: true, noop: true });

    const { error } = await sb.from('household_members').update(patch).eq('id', id);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'list_directory') {
    // Return opted-in members across the tenant (replaces the paper directory).
    // Only the requesting member's household sees full contact; everyone else
    // sees just name + role + (optional) family_name. Members can opt in/out
    // via update_household_member { directory_visible: bool }.
    const { data: members } = await sb.from('household_members')
      .select('id, name, role, household_id, directory_visible')
      .eq('tenant_id', payload.tid as string)
      .eq('active', true).eq('directory_visible', true)
      .order('name', { ascending: true });
    const hids = [...new Set((members ?? []).map(m => m.household_id))];
    const { data: households } = hids.length
      ? await sb.from('households').select('id, family_name').in('id', hids).eq('active', true)
      : { data: [] };
    const byHid = new Map((households ?? []).map(h => [h.id, h.family_name]));
    return jsonResponse({
      ok: true,
      members: (members ?? []).map(m => ({
        id: m.id, name: m.name, role: m.role,
        family_name: byHid.get(m.household_id) ?? null,
      })),
    });
  }

  if (action === 'logout') {
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

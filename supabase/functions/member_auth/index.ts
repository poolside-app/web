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
  // SMS_DEV_MODE forces dev_link fallback for testing while waiting for
  // A2P 10DLC approval. The function does NOT call Twilio when set.
  if (Deno.env.get('SMS_DEV_MODE') === '1') return { sent: false, error: 'SMS_DEV_MODE on (testing)' };
  const sid    = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token  = Deno.env.get('TWILIO_AUTH_TOKEN');
  const fromN  = Deno.env.get('TWILIO_FROM_NUMBER');
  // MessagingServiceSid takes precedence — routes through registered A2P
  // 10DLC Campaign so US carriers accept the message (error 30034 fix).
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') || '';
  if (!sid || !token || (!messagingServiceSid && !fromN)) return { sent: false, error: 'TWILIO_* env vars not set' };
  const body = `Sign in to ${args.tenantName}: ${args.verifyLink}\n(Link expires in 15 minutes.)`;
  const params: Record<string, string> = { To: args.to, Body: body };
  if (messagingServiceSid) params.MessagingServiceSid = messagingServiceSid;
  else if (fromN) params.From = fromN;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${sid}:${token}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
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

    // Anti-timing-leak: ensure both no-match and match paths return at
    // roughly the same wall-clock time so an attacker can't enumerate
    // members. Without this, the match path takes ~700ms (DB insert +
    // Resend/Twilio POST) while the no-match path returns in ~50ms.
    const startMs = Date.now();
    const MIN_RESPONSE_MS = 800;
    const padTime = async () => {
      const elapsed = Date.now() - startMs;
      if (elapsed < MIN_RESPONSE_MS) {
        await new Promise(r => setTimeout(r, MIN_RESPONSE_MS - elapsed));
      }
    };

    let memberQuery = sb.from('household_members')
      .select('id, name, email, phone_e164, household_id, active')
      .eq('tenant_id', tenant.id).eq('active', true);
    if (phone_e164) memberQuery = memberQuery.eq('phone_e164', phone_e164);
    else memberQuery = memberQuery.ilike('email', email!);
    const { data: member } = await memberQuery.maybeSingle();

    if (!member) {
      await padTime();
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
      if (send.sent) { await padTime(); return jsonResponse(generic); }
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
    // Tighten cross-tenant guard: previously `slug &&` short-circuited so an
    // empty slug bypassed the check. Now require the slug to be non-empty
    // AND match. m/verify.html always sends a slug from the subdomain.
    if (!slug || slug !== tenant.slug) {
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
    // Long-lived JWT — members are expected to "stay logged in forever"
    // once they install the app. Sliding renewal in the `me` action below
    // keeps active users on a rolling window so they effectively never
    // see a login form again.
    const jwt = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub: member.id, kind: 'member',
        tid: tenant.id, slug: tenant.slug, hid: member.household_id,
        exp: getNumericDate(60 * 60 * 24 * 365 * 5),  // 5 years
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

    // Sliding session: mint a fresh 5-year token on every `me` call. Active
    // users (anyone who opens the app at any cadence) stay logged in
    // indefinitely. /m/ writes the new token back to localStorage so the
    // expiry rolls forward without the user noticing.
    let refreshed_token: string | null = null;
    try {
      const key = await getKey();
      refreshed_token = await create(
        { alg: 'HS256', typ: 'JWT' },
        {
          sub: payload.sub, kind: 'member',
          tid: payload.tid, slug: tenant.slug, hid: payload.hid,
          exp: getNumericDate(60 * 60 * 24 * 365 * 5),
        },
        key,
      );
    } catch { /* non-fatal — caller keeps the existing token */ }

    return jsonResponse({
      ok: true,
      user: member,
      tenant,
      household: { ...household, members: housemates ?? [] },
      documents: docs ?? [],
      refreshed_token,
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

  // ── add_household_member ───────────────────────────────────────────────
  // The primary household member can add additional family members from /m/
  // without going back through the full apply flow. The new member still
  // needs legal-evidence: accepted policies + a signature (theirs if adult,
  // the guardian-primary's if minor). Cap respected (8/household via DB
  // trigger fn_household_member_cap).
  if (action === 'add_household_member') {
    const me = await sb.from('household_members')
      .select('id, role, household_id, tenant_id, name, active')
      .eq('id', payload.sub).maybeSingle();
    if (!me.data || !me.data.active) {
      return jsonResponse({ ok: false, error: 'Member not active' }, 403);
    }
    if (me.data.role !== 'primary') {
      return jsonResponse({ ok: false, error: 'Only the primary member can add household members' }, 403);
    }

    const b = body as Record<string, unknown>;
    const name = String(b.name ?? '').trim();
    const dob = b.dob ? String(b.dob).slice(0, 10) : null;
    const role = String(b.role ?? 'adult').toLowerCase();
    const email = b.email ? String(b.email).trim().toLowerCase() : null;
    const phoneRaw = b.phone ? String(b.phone).trim() : '';
    const policiesAccepted = (b.policies_accepted && typeof b.policies_accepted === 'object')
      ? b.policies_accepted as Record<string, boolean>
      : {};
    const signature = b.signature ? String(b.signature).slice(0, 200000) : null;
    const guardianSignature = b.guardian_signature ? String(b.guardian_signature).slice(0, 200000) : null;

    if (!name) return jsonResponse({ ok: false, error: 'Name is required' }, 400);
    if (!['adult', 'teen', 'child'].includes(role)) {
      return jsonResponse({ ok: false, error: 'Role must be adult, teen, or child' }, 400);
    }
    if (email && (!email.includes('@') || email.length > 200)) {
      return jsonResponse({ ok: false, error: 'Invalid email' }, 400);
    }
    let phone: string | null = null;
    if (phoneRaw) {
      const digits = phoneRaw.replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) phone = digits;
      else if (/^\d{10}$/.test(digits)) phone = '+1' + digits;
      else if (/^1\d{10}$/.test(digits)) phone = '+' + digits;
      else return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    }

    // Verify all required policies are accepted
    const { data: required } = await sb.from('policies')
      .select('slug, title')
      .eq('tenant_id', me.data.tenant_id)
      .eq('active', true).eq('required_for_apply', true);
    const missing = (required ?? []).filter(p => !policiesAccepted[p.slug as string]);
    if (missing.length) {
      return jsonResponse({
        ok: false,
        error: `Please accept all policies: ${missing.map(p => p.title).join(', ')}`,
      }, 400);
    }

    // Signature requirement: adults sign for themselves, minors require
    // a guardian signature from the logged-in primary.
    if (role === 'adult' && !signature) {
      return jsonResponse({ ok: false, error: 'Adult members must sign for themselves' }, 400);
    }
    if ((role === 'teen' || role === 'child') && !guardianSignature) {
      return jsonResponse({ ok: false, error: 'A guardian signature is required for minors' }, 400);
    }

    // Insert the new member. The DB trigger fn_household_member_cap
    // throws at #9, so we let it raise and translate the error.
    const now = new Date().toISOString();
    const insertPayload: Record<string, unknown> = {
      tenant_id: me.data.tenant_id,
      household_id: me.data.household_id,
      name,
      role,
      email,
      phone_e164: phone,
      can_unlock_gate: role === 'adult' || role === 'teen',
      can_book_parties: false,
      active: true,
      confirmed_at: now,
      policies_accepted: policiesAccepted,
      policies_accepted_at: now,
      signature_url: role === 'adult' ? signature : null,
      guardian_signature_url: (role === 'teen' || role === 'child') ? guardianSignature : null,
      added_by_member_id: payload.sub,
      added_via: 'member_add',
    };
    const { data: created, error } = await sb.from('household_members')
      .insert(insertPayload).select('id, name, role').single();
    if (error) {
      const friendly = String(error.message).includes('member_cap')
        ? 'Your household is at the maximum size. Ask the board if you need to make changes.'
        : error.message;
      return jsonResponse({ ok: false, error: friendly }, 400);
    }

    // Audit log + admin task so the board sees it.
    try {
      await sb.from('audit_log').insert({
        tenant_id: me.data.tenant_id,
        kind: 'household_member.member_added',
        entity_type: 'household_member', entity_id: created.id,
        summary: `${me.data.name} added ${name} (${role}) to their household`,
        actor_id: payload.sub, actor_kind: 'member',
        metadata: { household_id: me.data.household_id, role },
      });
      await sb.from('admin_tasks').insert({
        tenant_id: me.data.tenant_id,
        target_scopes: ['applications'],
        kind: 'household_member.member_added',
        summary: `New household member added: ${name} (${role}) — by ${me.data.name}`,
        link_url: '/club/admin/households.html',
        source_kind: 'household_member', source_id: created.id,
      });
    } catch { /* best-effort */ }

    // ── Render legal-evidence PDF, email primary with attachment, sync to Drive ──
    // Same render() bytes are reused for both the email attachment AND the
    // Drive upload — single source of truth so the household's copy and the
    // club's archive are bit-for-bit identical.
    let pdfBytes: Uint8Array | null = null;
    let emailSent = false;
    let emailError: string | null = null;
    try {
      const [{ data: tenant }, { data: household }, { data: policiesAll }] = await Promise.all([
        sb.from('tenants').select('id, slug, display_name')
          .eq('id', me.data.tenant_id).maybeSingle(),
        sb.from('households').select('id, family_name')
          .eq('id', me.data.household_id).maybeSingle(),
        sb.from('policies')
          .select('slug, title, body, sort_order')
          .eq('tenant_id', me.data.tenant_id)
          .eq('active', true).eq('required_for_apply', true)
          .order('sort_order', { ascending: true }),
      ]);

      if (tenant && household) {
        const { renderAddedMemberPdf } = await import('../_shared/household_member_pdf.ts');
        const addedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
        pdfBytes = await renderAddedMemberPdf({
          member_id: created.id,
          tenant_display_name: tenant.display_name,
          added_at: addedAt,
          family_name: household.family_name as string,
          primary_name: me.data.name,
          member_name: name,
          member_role: role as 'adult' | 'teen' | 'child',
          member_dob: dob,
          member_email: email,
          member_phone: phone,
          policies: (policiesAll ?? []).map(p => ({
            slug: p.slug as string,
            title: p.title as string,
            body: (p.body as string) ?? '',
            sort_order: (p.sort_order as number) ?? 0,
            accepted: !!policiesAccepted[p.slug as string],
          })),
          signature_data_url: role === 'adult' ? signature : null,
          guardian_signature_data_url: (role === 'teen' || role === 'child') ? guardianSignature : null,
        });

        // Email primary with PDF attached (registry-backed, admin can override).
        const { data: primary } = await sb.from('household_members')
          .select('email').eq('id', payload.sub as string).maybeSingle();
        const recipient = (primary?.email as string | null) ?? null;
        if (recipient && pdfBytes) {
          const { renderAndSend } = await import('../_shared/email_template.ts');
          const { bytesToBase64 } = await import('../_shared/send_email.ts');
          const safeFamily = (household.family_name as string).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
          const dateStr = new Date().toISOString().slice(0, 10);
          const r = await renderAndSend(sb, {
            tenantId: me.data.tenant_id,
            templateKey: 'household_member_added',
            to: recipient,
            variables: {
              tenant_name: tenant.display_name,
              family_name: household.family_name as string,
              primary_name: me.data.name,
              member_name: name,
              member_role: role,
              club_url: `https://${tenant.slug}.poolsideapp.com`,
            },
            attachments: [{
              filename: `${safeFamily}-member-${dateStr}.pdf`,
              content: bytesToBase64(pdfBytes),
              contentType: 'application/pdf',
            }],
          });
          emailSent = !!r.sent;
          if (!r.sent) emailError = r.error || (r.suppressed ? 'suppressed' : null);
        }

        // Drive upload — best-effort. Lands in the same club folder as
        // applications, but in a "Household additions" subfolder by year so
        // the apply-roster spreadsheet stays clean.
        const GOOGLE_ID  = Deno.env.get('GOOGLE_CLIENT_ID');
        const GOOGLE_SEC = Deno.env.get('GOOGLE_CLIENT_SECRET');
        if (GOOGLE_ID && GOOGLE_SEC && pdfBytes) {
          try {
            const { loadGrant, getAccessToken, ensureFolder, uploadPdf, updateGrantCache } =
              await import('../_shared/google_drive.ts');
            const grant = await loadGrant(sb, me.data.tenant_id);
            if (grant) {
              const accessToken = await getAccessToken(grant.refresh_token, GOOGLE_ID, GOOGLE_SEC);
              const rootId = await ensureFolder(accessToken, 'Poolside Archive', 'root', grant.root_folder_id);
              const clubId = await ensureFolder(accessToken, tenant.display_name || tenant.slug, rootId, grant.club_folder_id);
              const year = String(new Date().getUTCFullYear());
              const additionsParent = await ensureFolder(accessToken, 'Household additions', clubId, null);
              const yearFolder = await ensureFolder(accessToken, year, additionsParent, null);
              const safeFamily = (household.family_name as string).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
              const safeMember = name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 40);
              const dateStr = new Date().toISOString().slice(0, 10);
              const filename = `${safeFamily}-${safeMember}-${dateStr}-${created.id.slice(0, 8)}.pdf`;
              await uploadPdf(accessToken, yearFolder, filename, pdfBytes);
              // Persist any new top-level cache fields we may have minted.
              if (rootId !== grant.root_folder_id || clubId !== grant.club_folder_id) {
                await updateGrantCache(sb, me.data.tenant_id, {
                  root_folder_id: rootId, club_folder_id: clubId,
                });
              }
            }
          } catch (e) {
            console.error('Drive upload (added member) failed (non-fatal):', (e as Error).message);
          }
        }
      }
    } catch (e) {
      console.error('add_household_member post-insert (non-fatal):', (e as Error).message);
    }

    return jsonResponse({
      ok: true,
      member_id: created.id, name: created.name, role: created.role,
      email_sent: emailSent,
      email_error: emailError,
    });
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

  // list_directory removed 2026-05-05 — the cross-household member roster
  // exposed names to anyone who could sign in, even with an opt-in toggle.
  // For small clubs with kids that's a privacy concern. Admins still see
  // contacts via the admin Households page. The DB column
  // household_members.directory_visible is kept but unread.
  if (action === 'list_directory') {
    return jsonResponse({ ok: false, error: 'Member directory has been removed.' }, 410);
  }

  // ── update_household ───────────────────────────────────────────────────
  // Primary edits household-level info (family name, address, emergency
  // contact). Permission/role management of individual members goes through
  // update_household_member instead.
  if (action === 'update_household') {
    const r = await requirePrimary();
    if ('error' in r && r.error) return jsonResponse({ ok: false, error: r.error }, r.code);
    const b = body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (b.family_name !== undefined) {
      const v = String(b.family_name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Family name cannot be empty' }, 400);
      patch.family_name = v.slice(0, 120);
    }
    if (b.address !== undefined)  patch.address  = String(b.address ?? '').trim().slice(0, 200) || null;
    if (b.city    !== undefined)  patch.city     = String(b.city    ?? '').trim().slice(0,  80) || null;
    if (b.zip     !== undefined)  patch.zip      = String(b.zip     ?? '').trim().slice(0,  20) || null;
    if (b.emergency_contact !== undefined) patch.emergency_contact = String(b.emergency_contact ?? '').trim().slice(0, 200) || null;
    if (Object.keys(patch).length === 0) return jsonResponse({ ok: true, noop: true });
    patch.updated_at = new Date().toISOString();
    const { error } = await sb.from('households').update(patch).eq('id', payload.hid as string);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid as string,
        kind: 'household.update', entity_type: 'household', entity_id: payload.hid,
        summary: `Primary updated household info`,
        actor_id: payload.sub as string, actor_kind: 'member',
        metadata: patch,
      });
    } catch { /* best-effort */ }
    return jsonResponse({ ok: true });
  }

  // ── transfer_primary ───────────────────────────────────────────────────
  // Hand the primary-contact role to another active adult in the household.
  // Old primary becomes a regular adult. The JWT doesn't carry role, so the
  // user just has to refresh /m/ to pick up the new (reduced) permissions.
  if (action === 'transfer_primary') {
    const r = await requirePrimary();
    if ('error' in r && r.error) return jsonResponse({ ok: false, error: r.error }, r.code);
    const newId = String((body as Record<string, unknown>).new_primary_id ?? '');
    if (!newId) return jsonResponse({ ok: false, error: 'new_primary_id required' }, 400);
    if (newId === payload.sub) return jsonResponse({ ok: false, error: 'Pick someone other than yourself' }, 400);
    const { data: target } = await sb.from('household_members')
      .select('id, name, role, household_id, active, phone_e164')
      .eq('id', newId).maybeSingle();
    if (!target) return jsonResponse({ ok: false, error: 'Member not found' }, 404);
    if (target.household_id !== payload.hid) return jsonResponse({ ok: false, error: 'Not in your household' }, 403);
    if (!target.active) return jsonResponse({ ok: false, error: 'That member is inactive' }, 400);
    if (target.role !== 'adult') return jsonResponse({ ok: false, error: 'Only adults can become primary' }, 400);
    if (!target.phone_e164) return jsonResponse({ ok: false, error: 'New primary needs a phone number first' }, 400);

    // Two-step swap: demote me, promote them. The DB doesn't enforce a
    // single-primary-per-household constraint by default; if a partial
    // failure left two primaries, an admin can fix it from the admin UI.
    const now = new Date().toISOString();
    const demote = await sb.from('household_members')
      .update({ role: 'adult', updated_at: now }).eq('id', payload.sub as string);
    if (demote.error) return jsonResponse({ ok: false, error: demote.error.message }, 500);
    const promote = await sb.from('household_members')
      .update({ role: 'primary', can_unlock_gate: true, can_book_parties: true, updated_at: now }).eq('id', newId);
    if (promote.error) {
      // Rollback the demotion best-effort.
      await sb.from('household_members').update({ role: 'primary' }).eq('id', payload.sub as string);
      return jsonResponse({ ok: false, error: promote.error.message }, 500);
    }
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid as string,
        kind: 'household.transfer_primary', entity_type: 'household', entity_id: payload.hid,
        summary: `Primary role transferred to ${target.name}`,
        actor_id: payload.sub as string, actor_kind: 'member',
        metadata: { old_primary: payload.sub, new_primary: newId },
      });
      await sb.from('admin_tasks').insert({
        tenant_id: payload.tid as string,
        target_scopes: ['membership'],
        kind: 'household.transfer_primary',
        summary: `Primary role transferred to ${target.name}`,
        link_url: '/club/admin/households.html',
        source_kind: 'household_member', source_id: newId,
      });
    } catch { /* best-effort */ }
    return jsonResponse({ ok: true });
  }

  if (action === 'logout') {
    return jsonResponse({ ok: true });
  }

  // ── submit_photo ───────────────────────────────────────────────────────
  // Member uploads a photo. Lands in club-assets storage immediately but the
  // photos row is created with status='pending' — admin must approve before
  // it appears in the public/member gallery carousel.
  // Body: { content_type, base64, caption? }
  if (action === 'submit_photo') {
    const content_type = String(body.content_type ?? '').trim();
    const base64       = String(body.base64 ?? '');
    const caption      = String(body.caption ?? '').trim().slice(0, 200) || null;
    if (!content_type || !base64) {
      return jsonResponse({ ok: false, error: 'content_type and base64 are required' }, 400);
    }
    const ALLOWED = new Set(['image/jpeg','image/png','image/webp','image/gif']);
    if (!ALLOWED.has(content_type)) {
      return jsonResponse({ ok: false, error: 'Only JPG / PNG / WebP / GIF images allowed' }, 400);
    }
    let bytes: Uint8Array;
    try {
      const bin = atob(base64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } catch {
      return jsonResponse({ ok: false, error: 'Invalid base64 data' }, 400);
    }
    if (bytes.byteLength > 8 * 1024 * 1024) {
      return jsonResponse({ ok: false, error: 'Image too large (max 8 MB)' }, 400);
    }

    const tid = payload.tid as string;
    const id  = crypto.randomUUID();
    const extMap: Record<string, string> = {
      'image/jpeg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif',
    };
    const path = `${tid}/member-uploads/${id}.${extMap[content_type]}`;
    const { error: upErr } = await sb.storage.from('club-assets')
      .upload(path, bytes, { contentType: content_type, upsert: false });
    if (upErr) return jsonResponse({ ok: false, error: upErr.message }, 500);
    const { data: pub } = sb.storage.from('club-assets').getPublicUrl(path);

    // Look up the member's name to stamp on the photos row (so admin reviewer
    // sees who submitted it without joining household_members later).
    const { data: member } = await sb.from('household_members')
      .select('name').eq('id', payload.sub as string).maybeSingle();

    const { data: photo, error: phErr } = await sb.from('photos').insert({
      tenant_id: tid,
      url: pub.publicUrl,
      caption,
      status: 'pending',
      uploaded_by_kind: 'member',
      uploaded_by_member_id: payload.sub as string,
      uploader_name: member?.name ?? null,
      active: true,
    }).select('id').single();
    if (phErr) return jsonResponse({ ok: false, error: phErr.message }, 500);

    // Open an admin task so the moderator queue surfaces this without polling
    await sb.from('admin_tasks').insert({
      tenant_id: tid,
      target_scopes: ['photos'],
      kind: 'photo.pending_approval',
      summary: `Photo from ${member?.name || 'a member'} pending approval`,
      link_url: '/club/admin/photos.html#pending',
      source_kind: 'photo', source_id: photo.id,
    });

    return jsonResponse({ ok: true, photo_id: photo.id, url: pub.publicUrl, status: 'pending' });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

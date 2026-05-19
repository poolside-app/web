// =============================================================================
// tenant_admin_auth — Per-tenant admin login
// =============================================================================
// Counterpart to admin_auth (which is provider-only). Authenticates against
// admin_users scoped to a tenant, identified by the slug carried with the
// request. JWTs signed with the same ADMIN_JWT_SECRET but with
// kind='tenant_admin' so the two surfaces stay distinct.
//
// Actions:
//
//   { action: 'login', slug, email, password }
//     → { ok, token, user: { id, email, display_name, is_super, is_default_pw }, tenant: { slug, display_name } }
//
//   { action: 'me' }                    [requires Authorization: Bearer <token>]
//     → { ok, user, tenant }
//
//   { action: 'change_password', current_password, new_password }
//                                       [requires Authorization]
//     → { ok }
//
//   { action: 'logout' }                — client just drops the token; server is stateless
//     → { ok }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { create, verify, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireOwner } from '../_shared/auth.ts';
import { checkGlobalSmsKillSwitch } from '../_shared/sms_cap.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM    = Deno.env.get('RESEND_FROM') || 'Poolside <onboarding@resend.dev>';
const TWILIO_SID     = Deno.env.get('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN');
const TWILIO_FROM_N  = Deno.env.get('TWILIO_FROM_NUMBER');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function escAdmin(s: unknown): string {
  const map: Record<string, string> = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, (c) => map[c] || c);
}

async function sendAdminInviteEmail(args: {
  to: string; tenantName: string; clubUrl: string; tempPassword: string;
  inviteeName: string; roleLabel: string;
}) {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not set' };
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a"><h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">You're invited to ${escAdmin(args.tenantName)}</h2><p style="margin:0 0 16px;color:#64748b">Hi ${escAdmin(args.inviteeName)} — you've been added as a <b>${escAdmin(args.roleLabel)}</b>.</p><p style="margin:24px 0"><a href="${args.clubUrl}/club/admin/login.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in</a></p><div style="background:#f7f3eb;border-radius:10px;padding:14px 16px;margin-bottom:14px;font-family:monospace;font-size:13px"><div>Email: <b>${escAdmin(args.to)}</b></div><div>Temp password: <b>${escAdmin(args.tempPassword)}</b></div></div><p style="margin:0;color:#94a3b8;font-size:12px">You'll be prompted to set a new password on first login.</p></div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [args.to], subject: `You're an admin on ${args.tenantName}`, html }),
    });
    if (!res.ok) { const t = await res.text(); return { sent: false, error: `Resend ${res.status}: ${t.slice(0, 200)}` }; }
    return { sent: true };
  } catch (e) { return { sent: false, error: String(e) }; }
}

async function sendAdminEmailLink(args: { to: string; tenantName: string; clubUrl: string; verifyLink: string; adminName: string }) {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not set' };
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a"><h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Sign in to ${escAdmin(args.tenantName)}</h2><p style="margin:0 0 16px;color:#64748b">Hi ${escAdmin(args.adminName || 'there')} — click below to sign in. The link is good for one use and expires in 15 minutes.</p><p style="margin:24px 0"><a href="${args.verifyLink}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in</a></p></div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [args.to], subject: `Sign in to ${args.tenantName}`, html }),
    });
    if (!res.ok) { const t = await res.text(); return { sent: false, error: `Resend ${res.status}: ${t.slice(0, 200)}` }; }
    return { sent: true };
  } catch (e) { return { sent: false, error: String(e) }; }
}

// SMS sign-in body: short, code-prominent. iOS + Android auto-detect the
// "code is XXXXXX" pattern and offer one-tap autofill from the keyboard
// suggestion bar — far better UX than asking users to copy/paste a long URL.
async function sendAdminSmsCode(args: { to: string; tenantName: string; code: string; sb: ReturnType<typeof createClient> }) {
  if (Deno.env.get('SMS_DEV_MODE') === '1') return { sent: false, error: 'SMS_DEV_MODE on (testing)' };
  const gate = await checkGlobalSmsKillSwitch(args.sb, args.to);
  if (gate.blocked) return { sent: false, error: `SMS kill-switch tripped (${gate.reason}: ${gate.used}/${gate.cap})` };
  const sid = TWILIO_SID, tok = TWILIO_TOKEN;
  // Prefer MessagingServiceSid when set — it routes the send through our
  // registered A2P 10DLC Campaign so US carriers don't drop the message
  // with error 30034. Falls back to raw From number for setups that
  // haven't completed 10DLC registration yet.
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') || '';
  const from = TWILIO_FROM_N;
  if (!sid || !tok || (!messagingServiceSid && !from)) {
    return { sent: false, error: 'TWILIO_* env vars not set' };
  }
  const smsBody = `Your ${args.tenantName} sign-in code is ${args.code}. Expires in 10 min. If you didn't ask for it, ignore this message.`;
  const params: Record<string, string> = { To: args.to, Body: smsBody };
  if (messagingServiceSid) params.MessagingServiceSid = messagingServiceSid;
  else if (from) params.From = from;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + btoa(`${sid}:${tok}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) { const t = await res.text(); return { sent: false, error: `Twilio ${res.status}: ${t.slice(0, 200)}` }; }
    return { sent: true };
  } catch (e) { return { sent: false, error: String(e) }; }
}

// Generate a cryptographically random 6-digit code (100000–999999, never
// leading zeros). Caller hashes + stores in admin_magic_links.token_hash.
function generateOtpCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

async function getJwtKey(): Promise<CryptoKey> {
  if (!JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

type TenantAdminPayload = {
  sub: string; kind: 'tenant_admin'; tid: string; slug: string; exp: number;
  impersonated_by?: string; synthetic?: boolean;
};

// Predefined role templates. The `owner` template is special — it skips
// scope checks entirely (used for the original signup admin + super-users).
// Customize a template by editing scopes after assignment; role_template
// flips to 'custom' the moment the resolved scopes diverge from the
// template's canonical set.
// Role-template labels follow the 2026-05 design spec: volunteer-job names,
// not "Owner / President". The slugs stay the same for back-compat — DB
// rows already reference them and changing them would force a data migration
// for zero functional benefit. Labels are what humans see; slugs are internal.
const ROLE_TEMPLATES: Record<string, { label: string; description: string; scopes: string[] }> = {
  owner: {
    label: 'Board chair',
    description: 'Sees and changes everything. Can also add or remove other admins.',
    scopes: [],   // sentinel: empty + owner = full access (bypasses scope checks)
  },
  treasurer: {
    label: 'Treasurer',
    description: 'Money and payments. Can mark paid, send reminders, refund.',
    scopes: ['payments', 'applications', 'tiers', 'renewals', 'audit', 'impact'],
  },
  membership: {
    label: 'Membership chair',
    description: 'Applications and households. Approves new members.',
    scopes: ['applications', 'households', 'tiers', 'renewals', 'directory', 'documents', 'impact'],
  },
  events: {
    label: 'Volunteer coordinator',
    description: 'Events and signups. Schedules parties, programs, and volunteer slots.',
    scopes: ['events', 'parties', 'programs', 'volunteer', 'passes', 'impact'],
  },
  communications: {
    label: 'Communications',
    description: 'Announcements, campaigns, and photo gallery.',
    scopes: ['announcements', 'campaigns', 'photos', 'documents', 'policies', 'impact'],
  },
  secretary: {
    label: 'Secretary',
    description: 'Takes board meeting minutes. Manages bylaws and other governance documents.',
    scopes: ['meetings', 'documents', 'impact'],
  },
  custom: {
    label: 'Custom',
    description: 'Pick exactly what this person can see and change. For unusual cases — most boards don\'t need this.',
    scopes: [],
  },
};

const ALL_SCOPES = [
  'applications', 'households', 'payments', 'tiers', 'renewals', 'events', 'programs', 'parties',
  'announcements', 'campaigns', 'volunteer', 'passes', 'photos', 'documents',
  'policies', 'directory', 'impact', 'audit',
  'meetings',
];

function templateScopes(name: string): string[] {
  const tpl = ROLE_TEMPLATES[name];
  return tpl ? [...tpl.scopes] : [];
}
function sanitizeScopes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const valid = new Set(ALL_SCOPES);
  return [...new Set(input.map(String).filter(s => valid.has(s)))];
}

async function signToken(
  adminUserId: string,
  tenantId: string,
  slug: string,
  extras: { role_template?: string | null; scopes?: string[] | null; is_super?: boolean | null } = {},
): Promise<string> {
  const key = await getJwtKey();
  return await create(
    { alg: 'HS256', typ: 'JWT' },
    {
      sub: adminUserId,
      kind: 'tenant_admin',
      tid: tenantId,
      slug,
      // Include role + scopes + super flag so downstream functions can
      // gate-check without a DB round-trip on every call. Owners (default)
      // get scopes=[] which the helpers treat as "full access" via the
      // role_template === 'owner' shortcut.
      role_template: extras.role_template ?? 'owner',
      scopes: extras.scopes ?? [],
      is_super: extras.is_super ?? false,
      // 100 days. Sliding-renewal lives in the `me` action below — every
       // me() call older than 7 days returns a fresh token so an active
       // user effectively never gets logged out. 100d cap protects against
       // truly abandoned sessions.
      exp: getNumericDate(60 * 60 * 24 * 100),
    },
    key,
  );
}

async function verifyToken(token: string): Promise<TenantAdminPayload | null> {
  try {
    const key = await getJwtKey();
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin') return null;
    if (!payload.sub || !payload.tid || !payload.slug) return null;
    return payload as unknown as TenantAdminPayload;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── login ──────────────────────────────────────────────────────────────
  if (action === 'login') {
    const slug     = String(body.slug ?? '').trim().toLowerCase();
    const email    = String(body.email ?? '').trim().toLowerCase();
    const password = String(body.password ?? '');
    if (!slug || !email || !password) {
      return jsonResponse({ ok: false, error: 'slug, email, and password are required' }, 400);
    }

    // Find tenant
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, status')
      .eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401);
    if (tenant.status === 'churned') {
      return jsonResponse({ ok: false, error: 'This club is no longer active' }, 403);
    }

    // Find the admin user inside that tenant. Match on either email or
    // username so people can log in with whatever they typed at signup.
    const { data: user } = await sb.from('admin_users')
      .select('id, email, username, display_name, password_hash, is_super, is_default_pw, active, scopes, role_template, phone_e164')
      .eq('tenant_id', tenant.id)
      .or(`email.eq.${email},username.eq.${email}`)
      .maybeSingle();
    if (!user || !user.active) {
      return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401);
    }

    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return jsonResponse({ ok: false, error: 'Invalid credentials' }, 401);

    await sb.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', user.id);

    const token = await signToken(user.id, tenant.id, tenant.slug, {
      role_template: user.role_template ?? 'owner',
      scopes: user.scopes ?? [],
      is_super: !!user.is_super,
    });
    return jsonResponse({
      ok: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        display_name: user.display_name,
        is_super: user.is_super,
        is_default_pw: user.is_default_pw,
        role_template: user.role_template ?? 'owner',
        scopes: user.scopes ?? [],
      },
      tenant: {
        slug: tenant.slug,
        display_name: tenant.display_name,
        status: tenant.status,
      },
    });
  }

  // ── start_link: public — request an email/SMS sign-in link by email or phone
  if (action === 'start_link') {
    const slugIn = String(body.slug ?? '').trim().toLowerCase();
    const raw    = String(body.identifier ?? body.email ?? body.phone ?? '').trim();
    if (!slugIn || !raw) return jsonResponse({ ok: false, error: 'slug + email/phone required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id, slug, display_name, status').eq('slug', slugIn).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.status === 'churned') return jsonResponse({ ok: false, error: 'This club is no longer active' }, 403);

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
      if (!email.includes('@')) return jsonResponse({ ok: false, error: 'Invalid email' }, 400);
    }

    // Channel hint sent back to the UI so it can show the right next step.
    // Phone path → "Enter the 6-digit code" form. Email path → "Check your
    // inbox for a sign-in link" message.
    const channel: 'sms' | 'email' = phone_e164 ? 'sms' : 'email';
    const generic = { ok: true, sent: true, channel, message: phone_e164
      ? 'If your number is on file, a 6-digit code is on its way.'
      : 'If your email is on file, a sign-in link is on its way.' };

    let q = sb.from('admin_users').select('id, display_name, email, phone_e164, active')
      .eq('tenant_id', tenant.id).eq('active', true);
    if (phone_e164) q = q.eq('phone_e164', phone_e164);
    else q = q.ilike('email', email as string);
    const { data: admin } = await q.maybeSingle();

    if (!admin) {
      await new Promise(r => setTimeout(r, 250));
      return jsonResponse(generic);
    }

    if (phone_e164) {
      // SMS path: 6-digit OTP code, 10-min expiry. Phone-savvy mental model
      // (every bank app does this). Resilient to brute-force via single-use
      // + short window; rate limit via existing sms_log + per-phone cap if
      // we see abuse later.
      // Insert with a tiny retry on the unique-token collision (1-in-1M
      // chance with random 6-digit codes; in practice never hits, but safe
      // to handle): if first insert fails, regenerate AND track which code
      // actually got stored so we send THAT one in the SMS.
      let finalCode: string | null = null;
      let lastErr: string | null = null;
      for (let attempt = 0; attempt < 3 && !finalCode; attempt++) {
        const tryCode = generateOtpCode();
        const tryHash = await sha256Hex(tryCode);
        const { error } = await sb.from('admin_magic_links').insert({
          tenant_id: tenant.id, admin_user_id: admin.id, token_hash: tryHash,
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        });
        if (!error) { finalCode = tryCode; break; }
        lastErr = error.message;
      }
      if (!finalCode) {
        return jsonResponse({ ok: false, error: 'Could not create sign-in code', detail: lastErr }, 500);
      }

      const send = await sendAdminSmsCode({ to: phone_e164, tenantName: tenant.display_name, code: finalCode, sb });
      await sb.from('sms_log').insert({
        tenant_id: tenant.id, category: 'auth', to_phone: phone_e164,
        success: send.sent, error: send.error ?? null, source: 'tenant_admin_auth.start_link',
      });
      if (send.sent) return jsonResponse(generic);
      // Dev-mode fallback: surface the code so the developer can sign in
      // even when Twilio isn't configured (testing, local). NEVER exposed
      // in production paths once Twilio is set up.
      return jsonResponse({ ok: true, sent: false, channel, message: 'SMS not configured. Use the code below.', dev_code: finalCode, dev_error: send.error });
    }

    // Email path: long random magic-link token (15-min expiry, one-tap
    // sign-in from any device). Familiar from every other email-sign-in
    // flow; works well in inbox UI.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
    const tokRaw = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    const tokenHash = await sha256Hex(tokRaw);
    await sb.from('admin_magic_links').insert({
      tenant_id: tenant.id, admin_user_id: admin.id, token_hash: tokenHash,
      expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
    });
    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const verifyLink = `${clubUrl}/club/admin/login.html#magic=${encodeURIComponent(tokRaw)}`;
    const send = await sendAdminEmailLink({ to: admin.email as string, tenantName: tenant.display_name, clubUrl, verifyLink, adminName: admin.display_name || '' });
    if (send.sent) return jsonResponse(generic);
    return jsonResponse({ ok: true, sent: false, channel, message: 'Email not configured. Use the link below.', dev_link: verifyLink, dev_error: send.error });
  }

  // verify_code: phone-OTP sign-in. Take phone + code, hash, look up an
  // unused, unexpired admin_magic_links row, mint JWT, mark used. Same
  // contract as verify_link below — returns { token, user, tenant } on
  // success.
  if (action === 'verify_code') {
    const slugIn  = String(body.slug ?? '').trim().toLowerCase();
    const phoneIn = String(body.phone ?? body.identifier ?? '').trim();
    const codeIn  = String(body.code ?? '').trim().replace(/\D/g, '');
    if (!slugIn || !phoneIn || codeIn.length !== 6) {
      return jsonResponse({ ok: false, error: 'slug + phone + 6-digit code required' }, 400);
    }
    const { data: tenant } = await sb.from('tenants').select('id, slug, display_name, status, plan, trial_ends_at, custom_domain, plan_label_override, household_cap_override, stripe_account_id, stripe_charges_enabled')
      .eq('slug', slugIn).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    const digits = phoneIn.replace(/[^\d+]/g, '');
    let phone_e164: string | null = null;
    if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) phone_e164 = digits;
    else if (/^\d{10}$/.test(digits)) phone_e164 = '+1' + digits;
    else if (/^1\d{10}$/.test(digits)) phone_e164 = '+' + digits;
    if (!phone_e164) return jsonResponse({ ok: false, error: 'Invalid phone' }, 400);

    const { data: admin } = await sb.from('admin_users')
      .select('id, email, phone_e164, display_name, is_super, is_default_pw, scopes, role_template, roles, active')
      .eq('tenant_id', tenant.id).eq('phone_e164', phone_e164).eq('active', true).maybeSingle();
    if (!admin) {
      await new Promise(r => setTimeout(r, 250));
      return jsonResponse({ ok: false, error: 'Wrong code or expired' }, 401);
    }

    const codeHash = await sha256Hex(codeIn);
    const { data: link } = await sb.from('admin_magic_links')
      .select('id, expires_at, used_at, admin_user_id')
      .eq('tenant_id', tenant.id)
      .eq('admin_user_id', admin.id)
      .eq('token_hash', codeHash)
      .maybeSingle();
    if (!link || link.used_at || new Date(link.expires_at).getTime() < Date.now()) {
      return jsonResponse({ ok: false, error: 'Wrong code or expired' }, 401);
    }
    await sb.from('admin_magic_links').update({ used_at: new Date().toISOString() }).eq('id', link.id);

    // Mint JWT (same shape as login/verify_link)
    const key = await getJwtKey();
    const jwtTok = await create(
      { alg: 'HS256', typ: 'JWT' },
      {
        sub: admin.id, kind: 'tenant_admin', tid: tenant.id, slug: tenant.slug,
        is_super: !!admin.is_super,
        scopes: admin.scopes ?? [],
        role_template: admin.role_template ?? null,
        roles: admin.roles ?? null,
        exp: getNumericDate(60 * 60 * 24 * 100),
      },
      key,
    );
    await sb.from('admin_users').update({ last_login_at: new Date().toISOString() }).eq('id', admin.id);
    return jsonResponse({
      ok: true,
      token: jwtTok,
      user: {
        id: admin.id,
        email: admin.email,
        display_name: admin.display_name,
        is_super: !!admin.is_super,
        is_default_pw: !!admin.is_default_pw,
        scopes: admin.scopes ?? [],
        role_template: admin.role_template ?? null,
        roles: admin.roles ?? null,
      },
      tenant,
    });
  }

  // ── verify_link: public — exchange a magic-link token for a JWT
  if (action === 'verify_link') {
    const slugIn = String(body.slug ?? '').trim().toLowerCase();
    const tokIn  = String(body.token ?? '').trim();
    if (!slugIn || !tokIn) return jsonResponse({ ok: false, error: 'slug + token required' }, 400);
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tokIn));
    const tokenHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    const { data: link } = await sb.from('admin_magic_links').select('id, tenant_id, admin_user_id, expires_at, used_at')
      .eq('token_hash', tokenHash).maybeSingle();
    if (!link) return jsonResponse({ ok: false, error: 'Invalid or expired sign-in link' }, 401);
    if (link.used_at) return jsonResponse({ ok: false, error: 'This sign-in link has already been used' }, 401);
    if (new Date(link.expires_at) < new Date()) return jsonResponse({ ok: false, error: 'This sign-in link has expired' }, 401);
    const { data: tenant } = await sb.from('tenants').select('id, slug, display_name, status').eq('id', link.tenant_id).maybeSingle();
    if (!tenant || tenant.slug !== slugIn) return jsonResponse({ ok: false, error: 'Wrong club' }, 401);
    const { data: admin } = await sb.from('admin_users')
      .select('id, email, display_name, is_super, is_default_pw, active, scopes, role_template, phone_e164')
      .eq('id', link.admin_user_id).maybeSingle();
    if (!admin || !admin.active) return jsonResponse({ ok: false, error: 'Admin not found' }, 401);
    await sb.from('admin_magic_links').update({ used_at: new Date().toISOString() }).eq('id', link.id);
    const jwt = await signToken(admin.id, tenant.id, tenant.slug, {
      role_template: admin.role_template ?? 'owner',
      scopes: admin.scopes ?? [],
      is_super: !!admin.is_super,
    });
    return jsonResponse({
      ok: true, token: jwt,
      user: {
        id: admin.id, email: admin.email, display_name: admin.display_name,
        is_super: admin.is_super, is_default_pw: admin.is_default_pw,
        role_template: admin.role_template ?? 'owner', scopes: admin.scopes ?? [],
      },
      tenant: { slug: tenant.slug, display_name: tenant.display_name, status: tenant.status },
    });
  }

  // Auth required for everything below
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyToken(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Invalid or expired session' }, 401);

  // ── me ─────────────────────────────────────────────────────────────────
  if (action === 'me') {
    const [{ data: user }, { data: tenant }, { data: settings }] = await Promise.all([
      sb.from('admin_users')
        .select('id, email, display_name, is_super, is_default_pw, active, scopes, role_template, roles, linked_member_id, member_apply_dismissed, phone_e164, board_title')
        .eq('id', payload.sub).maybeSingle(),
      sb.from('tenants')
        .select('slug, display_name, status, plan')
        .eq('id', payload.tid).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
    ]);
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 401);
    const settingsValue = (settings?.value ?? {}) as Record<string, unknown>;
    const features = settingsValue.features ?? {};
    const branding = settingsValue.branding ?? {};

    // Plan + capacity status — drives the persistent admin ticker.
    const { getHouseholdCapStatus, capStatusToJson } = await import('../_shared/plan_caps.ts');
    const cap = await getHouseholdCapStatus(sb, payload.tid, tenant.plan);
    const usage = capStatusToJson(cap);

    // Synthetic impersonation tokens have no real admin_users row — fall
    // back to a synthetic user identity sourced from the JWT itself.
    if ((!user || !user.active) && payload.synthetic) {
      return jsonResponse({
        ok: true,
        tenant: { ...tenant, features, branding },
        usage,
        user: {
          id: payload.sub,
          email: 'provider@poolsideapp.com',
          display_name: 'Provider (impersonating)',
          is_super: true,
          is_default_pw: false,
          impersonated: true,
          role_template: 'owner',
          scopes: [],
        },
      });
    }
    if (!user || !user.active) return jsonResponse({ ok: false, error: 'User not found' }, 401);

    // ── Sliding renewal ─────────────────────────────────────────────────
    // If the token's remaining lifetime is under 93 days (i.e. it's been
    // alive for more than 7), mint a fresh 100-day token and return it
    // so an active admin effectively never has to re-login. Skip for
    // impersonation tokens — they have a deliberately shorter cap.
    let renewed_token: string | null = null;
    if (!payload.impersonated_by && payload.exp && tenant.slug) {
      const remaining = (payload.exp as number) * 1000 - Date.now();
      const NINETY_THREE_DAYS_MS = 93 * 24 * 60 * 60 * 1000;
      if (remaining < NINETY_THREE_DAYS_MS) {
        try {
          renewed_token = await signToken(payload.sub, payload.tid, tenant.slug, {
            role_template: user.role_template ?? 'owner',
            scopes: (user.scopes ?? []) as string[],
            is_super: !!user.is_super,
          });
        } catch (_) { /* renewal best-effort; user keeps current token */ }
      }
    }

    return jsonResponse({
      ok: true,
      tenant: { ...tenant, features, branding },
      usage,
      renewed_token,
      user: {
        ...user,
        scopes: user.scopes ?? [],
        roles: (user.roles && Array.isArray(user.roles) && user.roles.length)
          ? user.roles
          : [user.role_template ?? 'owner'],
        role_template: user.role_template ?? 'owner',
        linked_member_id: user.linked_member_id ?? null,
        member_apply_dismissed: !!user.member_apply_dismissed,
        impersonated: !!payload.impersonated_by,
      },
    });
  }

  // ── change_password ────────────────────────────────────────────────────
  if (action === 'change_password') {
    if (payload.impersonated_by) {
      return jsonResponse({ ok: false, error: 'Cannot change password while impersonating' }, 403);
    }
    const cur = String(body.current_password ?? '');
    const nxt = String(body.new_password ?? '');
    if (!cur || !nxt) return jsonResponse({ ok: false, error: 'Both passwords are required' }, 400);
    if (nxt.length < 10) return jsonResponse({ ok: false, error: 'New password must be at least 10 characters' }, 400);

    const { data: user } = await sb.from('admin_users')
      .select('id, password_hash').eq('id', payload.sub).maybeSingle();
    if (!user) return jsonResponse({ ok: false, error: 'User not found' }, 401);

    const ok = await bcrypt.compare(cur, user.password_hash || '');
    if (!ok) return jsonResponse({ ok: false, error: 'Current password is incorrect' }, 401);

    const hash = await bcrypt.hash(nxt, 10);
    const { error } = await sb.from('admin_users')
      .update({ password_hash: hash, is_default_pw: false })
      .eq('id', payload.sub);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  // ── logout ─────────────────────────────────────────────────────────────
  if (action === 'logout') {
    return jsonResponse({ ok: true });
  }

  // ── Co-admin management ────────────────────────────────────────────────
  // Volunteer boards rotate. The first admin (from tenant_signup) needs to
  // grant access to the treasurer + secretary + president without dragging
  // Doug in. Anyone with an active admin_users row can manage their peers
  // — board self-governance, no super-admin tier required.

  if (action === 'list_admins') {
    const { data, error } = await sb.from('admin_users')
      .select('id, username, email, display_name, notify_pref, is_default_pw, is_super, active, last_login_at, created_at, scopes, role_template, roles, linked_member_id, phone_e164, board_title')
      .eq('tenant_id', payload.tid)
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Normalize roles[]: if the row has only legacy role_template, surface
    // it as a single-element roles[] so the UI can treat them uniformly.
    const admins = (data ?? []).map(a => ({
      ...a,
      roles: (a.roles && Array.isArray(a.roles) && a.roles.length)
        ? a.roles
        : [a.role_template ?? 'owner'],
    }));
    return jsonResponse({ ok: true, admins });
  }

  if (action === 'list_role_templates') {
    return jsonResponse({
      ok: true,
      templates: Object.entries(ROLE_TEMPLATES)
        .map(([key, t]) => ({ key, label: t.label, description: t.description, scopes: t.scopes })),
      all_scopes: ALL_SCOPES,
    });
  }

  if (action === 'invite_admin') {
    // OWNER ONLY: inviting new admins is a privilege-escalation surface
    // (you could invite yourself with new scopes via a deactivated peer).
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can invite new admins' }, 403);
    }
    const usernameRaw = String(body.username ?? '').trim().toLowerCase();
    const email       = String(body.email ?? '').trim().toLowerCase();
    const display_name = String(body.display_name ?? '').trim();
    const phone_raw    = String(body.phone_e164 ?? '').trim();
    const username = usernameRaw || email;
    if (!username || !username.includes('@')) {
      return jsonResponse({ ok: false, error: 'Email-shaped username is required' }, 400);
    }
    if (!display_name) return jsonResponse({ ok: false, error: 'Name is required' }, 400);

    // Resolve roles + scopes. New API accepts a `roles[]` array (multi-role,
    // e.g. ['communications', 'volunteer']). Legacy `role_template` (single
    // string) is honored for backward compatibility. If neither is provided,
    // default to 'membership' so the form has a sensible fallback.
    let roles: string[] = [];
    if (Array.isArray(body.roles) && body.roles.length) {
      const valid = new Set(Object.keys(ROLE_TEMPLATES));
      roles = [...new Set((body.roles as unknown[]).map(r => String(r).toLowerCase()).filter(r => valid.has(r)))];
    } else if (body.role_template) {
      const t = String(body.role_template).toLowerCase();
      if (ROLE_TEMPLATES[t]) roles = [t];
    }
    if (!roles.length) roles = ['membership'];

    // Compute scopes as the UNION of every role's template scopes. If the
    // caller passes an explicit scopes[] that doesn't match the union, the
    // role flips to 'custom' as a single-role record (custom = bespoke).
    const unionScopes = [...new Set(roles.flatMap(r => templateScopes(r)))];
    let scopes = unionScopes;
    let role_template = roles.length === 1 ? roles[0] : 'custom';
    if (body.scopes !== undefined) {
      const customScopes = sanitizeScopes(body.scopes);
      const matchesUnion = customScopes.length === unionScopes.length &&
        customScopes.every(s => unionScopes.includes(s));
      if (!matchesUnion) {
        scopes = customScopes;
        role_template = 'custom';
        roles = ['custom'];
      }
    }
    // Phone normalization (best-effort; reject obvious garbage but keep it permissive)
    let phone: string | null = null;
    if (phone_raw) {
      const digits = phone_raw.replace(/[^\d+]/g, '');
      if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) phone = digits;
      else if (/^\d{10}$/.test(digits)) phone = '+1' + digits;
      else if (/^1\d{10}$/.test(digits)) phone = '+' + digits;
      else return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    }

    // Make sure they don't already exist on this tenant
    const { data: clash } = await sb.from('admin_users').select('id, active')
      .eq('tenant_id', payload.tid).eq('username', username).maybeSingle();
    if (clash) {
      if (clash.active) return jsonResponse({ ok: false, error: 'That admin already exists' }, 409);
      // Reactivate stale row + apply the new role
      await sb.from('admin_users').update({
        active: true, display_name,
        email: email || username,
        scopes, role_template, roles,
        phone_e164: phone ?? null,
      }).eq('id', clash.id);
      return jsonResponse({ ok: true, admin_id: clash.id, reactivated: true, role_template, roles, scopes });
    }

    // Generate a temporary password — admin must change on first login.
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const tempPw = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
    const hash = await bcrypt.hash(tempPw, 10);

    // board_title — display-only label distinct from role_template
    // (permissions). Free text but the UI provides a dropdown of common
    // pool-club titles. Falls back to the role_template label if not set.
    const board_title = (() => {
      const s = String(body.board_title ?? '').trim();
      return s ? s.slice(0, 60) : null;
    })();
    const { data, error } = await sb.from('admin_users').insert({
      tenant_id: payload.tid,
      username, email: email || username, display_name,
      password_hash: hash,
      notify_pref: 'email',
      is_default_pw: true, active: true,
      scopes, role_template, roles, phone_e164: phone,
      board_title,
    }).select('id, username, display_name, email').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.invited', entity_type: 'admin_user', entity_id: data.id,
        summary: `Invited ${display_name} (${username}) as ${ROLE_TEMPLATES[role_template]?.label ?? role_template}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* ignore */ }

    // Send invite email if Resend is configured. Always also return
    // temp_password so the inviter can share verbally if email fails.
    const { data: tnt } = await sb.from('tenants').select('slug, display_name').eq('id', payload.tid).maybeSingle();
    const clubUrl = tnt ? `https://${tnt.slug}.poolsideapp.com` : '';
    const inviteEmail = await sendAdminInviteEmail({
      to: data.email || username,
      tenantName: tnt?.display_name || 'your club',
      clubUrl, tempPassword: tempPw, inviteeName: display_name,
      roleLabel: ROLE_TEMPLATES[role_template]?.label ?? role_template,
    });
    return jsonResponse({
      ok: true, admin_id: data.id, temp_password: tempPw, role_template, roles, scopes,
      invite_email_sent: inviteEmail.sent,
      invite_email_error: inviteEmail.sent ? null : inviteEmail.error,
    });
  }

  // Update just the board_title (display label). No permission impact;
  // any owner can change. Lighter-weight than update_admin_role since
  // it doesn't touch scopes.
  if (action === 'update_admin_title') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can change titles' }, 403);
    }
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const board_title = (() => {
      const s = String(body.board_title ?? '').trim();
      return s ? s.slice(0, 60) : null;
    })();
    const { error } = await sb.from('admin_users').update({ board_title })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'update_admin_role') {
    // OWNER ONLY: changing roles can promote any admin (including the
    // caller) to 'owner' or grant new scopes. Was previously open to any
    // tenant_admin token = privilege escalation.
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can change admin roles' }, 403);
    }
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: target } = await sb.from('admin_users')
      .select('id, tenant_id, role_template, roles')
      .eq('id', id).maybeSingle();
    if (!target || target.tenant_id !== payload.tid) {
      return jsonResponse({ ok: false, error: 'Admin not found' }, 404);
    }

    // Resolve the new roles[] from the request. Same logic as invite.
    let roles: string[] = [];
    if (Array.isArray(body.roles) && body.roles.length) {
      const valid = new Set(Object.keys(ROLE_TEMPLATES));
      roles = [...new Set((body.roles as unknown[]).map(r => String(r).toLowerCase()).filter(r => valid.has(r)))];
    } else if (body.role_template) {
      const t = String(body.role_template).toLowerCase();
      if (ROLE_TEMPLATES[t]) roles = [t];
    }
    if (!roles.length) roles = ['membership'];

    // Refuse to demote the last owner — would lock the tenant out of admin
    // management. Detect demotion by checking if the target currently has
    // 'owner' (in either roles[] or legacy role_template) but the new
    // roles[] does NOT include 'owner'.
    const targetRoles = (target.roles as string[] | null) ?? [];
    const wasOwner = target.role_template === 'owner' || targetRoles.includes('owner');
    const willBeOwner = roles.includes('owner');
    if (wasOwner && !willBeOwner) {
      const { data: owners } = await sb.from('admin_users')
        .select('id, role_template, roles')
        .eq('tenant_id', payload.tid).eq('active', true);
      const ownerCount = (owners ?? []).filter(a =>
        a.role_template === 'owner' ||
        (Array.isArray(a.roles) && a.roles.includes('owner'))
      ).length;
      if (ownerCount <= 1) {
        return jsonResponse({ ok: false, error: 'At least one Board chair must remain. Promote someone else first.' }, 400);
      }
    }

    // Compute scopes as union of the new roles[]. Custom scopes flip to 'custom'.
    const unionScopes = [...new Set(roles.flatMap(r => templateScopes(r)))];
    let scopes = unionScopes;
    let role_template = roles.length === 1 ? roles[0] : 'custom';
    if (body.scopes !== undefined) {
      const customScopes = sanitizeScopes(body.scopes);
      const matchesUnion = customScopes.length === unionScopes.length &&
        customScopes.every(s => unionScopes.includes(s));
      if (!matchesUnion) {
        scopes = customScopes;
        role_template = 'custom';
        roles = ['custom'];
      }
    }

    const { error } = await sb.from('admin_users').update({ scopes, role_template, roles })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.role_changed', entity_type: 'admin_user', entity_id: id,
        summary: `Changed role to ${roles.map(r => ROLE_TEMPLATES[r]?.label ?? r).join(' + ')}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
        metadata: { scopes, role_template, roles },
      });
    } catch { /* ignore */ }

    return jsonResponse({ ok: true, role_template, roles, scopes });
  }

  if (action === 'deactivate_admin') {
    // OWNER ONLY: deactivating peers locks them out (and combined with
    // password reset, lets a non-owner take over peer accounts).
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can deactivate other admins' }, 403);
    }
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    if (id === payload.sub) return jsonResponse({ ok: false, error: 'Can\'t deactivate yourself' }, 400);

    // Look up the target's roles so we can detect last-owner removal.
    const { data: target } = await sb.from('admin_users')
      .select('id, role_template, roles, display_name, email')
      .eq('id', id).eq('tenant_id', payload.tid).maybeSingle();
    if (!target) return jsonResponse({ ok: false, error: 'Admin not found' }, 404);

    // Don't strand the tenant — refuse if this is the last active admin overall.
    const { count } = await sb.from('admin_users').select('id', { count: 'exact', head: true })
      .eq('tenant_id', payload.tid).eq('active', true);
    if ((count ?? 0) <= 1) {
      return jsonResponse({ ok: false, error: 'At least one admin must remain active' }, 400);
    }

    // Bus-factor-1 owner guard: refuse if this is the last active Board chair
    // (owner). Otherwise no one would be able to manage admins or club settings.
    const targetRoles = (target.roles as string[] | null) ?? [];
    const targetIsOwner = target.role_template === 'owner' || targetRoles.includes('owner');
    if (targetIsOwner) {
      const { data: owners } = await sb.from('admin_users')
        .select('id, role_template, roles')
        .eq('tenant_id', payload.tid).eq('active', true);
      const ownerCount = (owners ?? []).filter(a =>
        a.role_template === 'owner' ||
        (Array.isArray(a.roles) && a.roles.includes('owner'))
      ).length;
      if (ownerCount <= 1) {
        return jsonResponse({
          ok: false,
          error: 'This is your last Board chair — promote someone else to Board chair first, then come back.',
        }, 400);
      }
    }

    const { error } = await sb.from('admin_users').update({ active: false })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.deactivated', entity_type: 'admin_user', entity_id: id,
        summary: `Removed ${target.display_name || target.email || 'admin'}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* ignore */ }
    return jsonResponse({ ok: true });
  }

  // Reactivate an admin who was previously deactivated. Mirrors the 30s-undo
  // pattern in the UI — admin clicks Remove, then Undo within the toast.
  // OWNER ONLY (same guard as deactivate).
  if (action === 'reactivate_admin') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can reactivate admins' }, 403);
    }
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('admin_users').update({ active: true })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    try {
      await sb.from('audit_log').insert({
        tenant_id: payload.tid, kind: 'admin.reactivated', entity_type: 'admin_user', entity_id: id,
        summary: 'Reactivated admin (undo)', actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* ignore */ }
    return jsonResponse({ ok: true });
  }

  // Self-service: dismiss the founder "set up your membership" banner. The
  // banner reappears if the admin clicks "Set up my membership" later (the
  // banner is gated on linked_member_id IS NULL AND member_apply_dismissed=false).
  if (action === 'dismiss_member_apply') {
    await sb.from('admin_users').update({ member_apply_dismissed: true })
      .eq('id', payload.sub).eq('tenant_id', payload.tid);
    return jsonResponse({ ok: true });
  }

  // Onboarding checklist state for the first-run dashboard. Returns the four
  // boolean steps + the apply URL the dashboard's "share apply link" card
  // shows. The fifth step ("share your apply link") is tracked client-side
  // via localStorage since there's no clean DB signal for "I clicked Copy".
  if (action === 'onboarding_status') {
    const [{ data: tenant }, { data: settings }, { data: admin }, { count: adminCount }] = await Promise.all([
      sb.from('tenants').select('slug, stripe_charges_enabled').eq('id', payload.tid).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
      sb.from('admin_users').select('linked_member_id').eq('id', payload.sub).maybeSingle(),
      sb.from('admin_users').select('id', { count: 'exact', head: true })
        .eq('tenant_id', payload.tid).eq('active', true),
    ]);
    const sv = (settings?.value as Record<string, unknown> | undefined) ?? {};
    const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
    const payments = (sv.payments as Record<string, unknown> | undefined) ?? {};
    const venmoHandle = String(payments.venmo_handle ?? '').trim();
    const slug = tenant?.slug ?? payload.slug ?? '';
    return jsonResponse({
      ok: true,
      apply_url: slug ? `https://${slug}.poolsideapp.com/apply.html` : null,
      steps: {
        tiers_set:        Array.isArray(tiers) && tiers.length > 0,
        payment_set:      !!venmoHandle || !!tenant?.stripe_charges_enabled,
        self_signup_done: !!admin?.linked_member_id,
        invite_board:     (adminCount ?? 0) > 1,
      },
    });
  }

  if (action === 'reset_admin_password') {
    // OWNER ONLY: was previously open to any tenant_admin — meaning a
    // scoped admin could reset a peer's password and steal their session.
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can reset other admins\' passwords' }, 403);
    }
    // Reset a peer's password — generates a fresh temp, returns it to caller
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: target } = await sb.from('admin_users').select('id, tenant_id, active')
      .eq('id', id).maybeSingle();
    if (!target || target.tenant_id !== payload.tid) return jsonResponse({ ok: false, error: 'Admin not found' }, 404);
    const bytes = new Uint8Array(9);
    crypto.getRandomValues(bytes);
    const tempPw = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
    const hash = await bcrypt.hash(tempPw, 10);
    const { error } = await sb.from('admin_users')
      .update({ password_hash: hash, is_default_pw: true })
      .eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, temp_password: tempPw });
  }

  // ── open_billing_portal: owner — generate a Stripe-hosted Customer Portal
  //    URL so they can self-manage their subscription: change payment method,
  //    download invoices, cancel, etc. Eliminates the "how do I update my
  //    card?" and "how do I cancel?" tickets that would otherwise all land
  //    in Doug's inbox. Requires the tenant to have a stripe_customer_id
  //    (set when they first upgraded out of Free).
  if (action === 'open_billing_portal') {
    const payload = await verifyAdmin(token);
    if (!payload) return jsonResponse({ ok: false, error: 'Auth required' }, 401);
    if (payload.role_template !== 'owner') {
      return jsonResponse({ ok: false, error: 'Only the club owner can open the billing portal' }, 403);
    }
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return jsonResponse({ ok: false, error: 'Stripe not configured' }, 500);

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, plan, stripe_customer_id')
      .eq('id', payload.tid).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (!tenant.stripe_customer_id) {
      return jsonResponse({ ok: false, error: 'You\'re on the Free plan — no subscription to manage yet. Upgrade to access the billing portal.' }, 400);
    }

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const params = new URLSearchParams();
    params.append('customer', tenant.stripe_customer_id);
    params.append('return_url', `${clubUrl}/club/admin/billing.html`);

    const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${stripeKey}:`),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const t = await res.text();
      return jsonResponse({ ok: false, error: `Stripe ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const session = await res.json();
    return jsonResponse({ ok: true, url: session.url });
  }

  // ── start_plan_upgrade: owner — open Stripe Checkout (subscription) for
  //    a new tier. Returns { url } for the client to redirect to. On payment
  //    success Stripe fires customer.subscription.created → webhook handler
  //    flips tenants.plan. Until that webhook lands, the tenant stays on
  //    their current plan (atomic upgrade — never half-upgraded state).
  if (action === 'start_plan_upgrade') {
    const payload = await verifyAdmin(token);
    if (!payload) return jsonResponse({ ok: false, error: 'Auth required' }, 401);
    if (payload.role_template !== 'owner') {
      return jsonResponse({ ok: false, error: 'Only the club owner can change the plan' }, 403);
    }
    const newPlan = String(body.new_plan ?? '').trim().toLowerCase();
    const PRICE_IDS: Record<string, string | undefined> = {
      starter:    Deno.env.get('STRIPE_PRICE_STARTER'),
      pro:        Deno.env.get('STRIPE_PRICE_PRO'),
      enterprise: Deno.env.get('STRIPE_PRICE_ENTERPRISE'),
    };
    const priceId = PRICE_IDS[newPlan];
    if (!priceId) {
      return jsonResponse({ ok: false, error: `Plan "${newPlan}" not available for self-serve upgrade yet — email hello@poolsideapp.com.` }, 400);
    }
    const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
    if (!stripeKey) return jsonResponse({ ok: false, error: 'Stripe not configured' }, 500);

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, plan, stripe_customer_id')
      .eq('id', payload.tid).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.plan === newPlan) {
      return jsonResponse({ ok: false, error: `Already on the ${newPlan} plan.` }, 400);
    }

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const params = new URLSearchParams();
    params.append('mode', 'subscription');
    params.append('line_items[0][price]', priceId);
    params.append('line_items[0][quantity]', '1');
    params.append('success_url', `${clubUrl}/club/admin/billing.html?upgraded=1`);
    params.append('cancel_url',  `${clubUrl}/club/admin/billing.html?upgraded=0`);
    if (tenant.stripe_customer_id) {
      params.append('customer', tenant.stripe_customer_id);
    }
    params.append('client_reference_id', `plan_upgrade:${tenant.id}:${newPlan}`);
    params.append('metadata[tenant_id]', tenant.id);
    params.append('metadata[new_plan]',  newPlan);
    params.append('metadata[kind]',      'plan_upgrade');
    params.append('subscription_data[metadata][tenant_id]', tenant.id);
    params.append('subscription_data[metadata][new_plan]',  newPlan);

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${stripeKey}:`),
        'Content-Type':  'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) {
      const t = await res.text();
      return jsonResponse({ ok: false, error: `Stripe ${res.status}: ${t.slice(0, 300)}` }, 502);
    }
    const session = await res.json();
    return jsonResponse({ ok: true, url: session.url, session_id: session.id });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

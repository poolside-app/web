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
  if (action === 'start') {
    const slug  = String(body.slug ?? '').trim().toLowerCase();
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!slug || !email || !email.includes('@')) {
      return jsonResponse({ ok: false, error: 'A valid club slug and email are required' }, 400);
    }
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, status')
      .eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.status === 'churned') {
      return jsonResponse({ ok: false, error: 'This club is no longer active' }, 403);
    }

    // Generic response on miss — don't leak which emails belong to the club.
    const generic = { ok: true, sent: true, message: 'If your email is on file, a sign-in link is on the way.' };

    const { data: member } = await sb.from('household_members')
      .select('id, name, email, household_id, active')
      .eq('tenant_id', tenant.id)
      .ilike('email', email)
      .eq('active', true)
      .maybeSingle();
    if (!member) {
      // Wait a beat to reduce timing-attack utility.
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
    const send = await sendMagicLinkEmail({
      to: member.email!, tenantName: tenant.display_name,
      clubUrl, verifyLink, memberName: member.name,
    });

    if (send.sent) return jsonResponse(generic);
    // Dev mode (no Resend key, or send failed): hand the link back so
    // testing without an email provider still works end-to-end.
    return jsonResponse({
      ok: true, sent: false,
      message: 'Email sending is not configured. Use the link below to sign in.',
      dev_link: verifyLink,
      dev_error: send.error,
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
        .select('id, name, email, phone_e164, role, household_id, can_unlock_gate, can_book_parties, active')
        .eq('id', payload.sub as string).maybeSingle(),
      sb.from('tenants')
        .select('slug, display_name, status')
        .eq('id', payload.tid as string).maybeSingle(),
      sb.from('households')
        .select('id, family_name, tier, fob_number, dues_paid_for_year, paid_until_year, address, city, zip, emergency_contact, active')
        .eq('id', payload.hid as string).maybeSingle(),
      sb.from('household_members')
        .select('id, name, role, phone_e164, email, active')
        .eq('household_id', payload.hid as string).eq('active', true)
        .order('role', { ascending: true })
        .order('created_at', { ascending: true }),
    ]);
    if (!member || !member.active) return jsonResponse({ ok: false, error: 'Member not found' }, 401);
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 401);
    if (!household || !household.active) return jsonResponse({ ok: false, error: 'Household not active' }, 401);
    return jsonResponse({
      ok: true,
      user: member,
      tenant,
      household: { ...household, members: housemates ?? [] },
    });
  }

  if (action === 'logout') {
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

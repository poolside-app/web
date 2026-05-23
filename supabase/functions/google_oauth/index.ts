// =============================================================================
// google_oauth — "Sign in with Google" for members AND tenant admins
// =============================================================================
// Public actions (no auth):
//   GET  /functions/v1/google_oauth?action=init&slug=<slug>&kind=<member|admin>&return_to=<url>
//     → 302 redirect to Google's OAuth consent screen
//
//   GET  /functions/v1/google_oauth?action=callback&code=...&state=...
//     → Verifies code with Google, finds-or-creates the user record by
//       google_sub or matching email, mints a JWT, and 302-redirects to
//       /m/verify.html#token=... or /club/admin/index.html#bootstrap=...
//
// Falls back to a clear error page if env vars aren't set yet.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const GOOGLE_CLIENT_ID     = Deno.env.get('GOOGLE_CLIENT_ID');
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');
// Public-facing redirect URI Google's consent screen displays. Proxied back
// to this function by a Vercel rewrite (/oauth/google/signin/callback) so
// users see "to continue to poolsideapp.com" instead of "supabase.co".
// Detect callback by presence of the `code` parameter Google appends
// (we can't put ?action=callback in the URI — Google requires exact match).
const GOOGLE_REDIRECT_URI  = Deno.env.get('GOOGLE_REDIRECT_URI')
  || 'https://www.poolsideapp.com/oauth/google/signin/callback';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'content-type': 'application/json' },
  });
}
// Optional CTA buttons attached below the message. When present, the
// generic "← Go back" link drops to a smaller secondary link so the
// primary action stands out.
type ErrorAction = { label: string; href: string };
function htmlError(msg: string, status = 400, opts?: { actions?: ErrorAction[]; title?: string }) {
  const title = opts?.title ?? 'Sign-in problem';
  const actions = opts?.actions ?? [];
  const actionsHtml = actions.length
    ? `<p style="margin-top:24px;display:flex;gap:10px;flex-wrap:wrap">${actions.map(a =>
        `<a href="${escAttr(a.href)}" style="display:inline-block;padding:11px 20px;background:#0a3b5c;color:#fff;text-decoration:none;border-radius:10px;font-weight:600;font-size:14px">${escHtml(a.label)}</a>`
      ).join('')}</p>
      <p style="margin-top:14px"><a href="javascript:history.back()" style="font-size:13px;color:#64748b">← Go back</a></p>`
    : `<p><a href="javascript:history.back()">← Go back</a></p>`;
  return new Response(`<!doctype html><meta charset="utf-8"><title>${escHtml(title)}</title>
    <body style="font-family:Inter,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#0f172a">
    <h1 style="font-family:Georgia,serif;color:#0a3b5c">${escHtml(title)}</h1>
    <p>${msg}</p>${actionsHtml}</body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function escHtml(s: string): string {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] as string));
}
function escAttr(s: string): string { return escHtml(s); }

async function getKey(): Promise<CryptoKey> {
  if (!JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}

// Encode a piece of state (slug, kind, return_to) into a signed token so
// the callback can recover it without trusting the URL.
async function encodeState(payload: Record<string, unknown>): Promise<string> {
  const key = await getKey();
  return await create({ alg: 'HS256', typ: 'JWT' }, {
    ...payload, exp: getNumericDate(60 * 10),  // 10-minute window for completion
  }, key);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const url = new URL(req.url);
  // If Google redirected back to us, the `code` query param will be set.
  // Treat that as the 'callback' action so we don't need the redirect URI
  // to carry an explicit ?action=callback (which would have to be registered
  // separately in Google Cloud Console).
  const action = url.searchParams.get('action')
    || (url.searchParams.get('code') ? 'callback' : '');

  // Public probe used by sign-in pages to decide whether to show the
  // "Continue with Google" button. Returns JSON, never redirects, no
  // auth required. Doesn't leak the client id — just configured: bool.
  if (action === 'status') {
    const configured = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
    return jsonResponse({ ok: true, configured });
  }

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return htmlError('Google sign-in isn\'t configured yet — ask the club admin to wire GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.', 503);
  }

  // ── init: redirect to Google ───────────────────────────────────────────
  if (action === 'init') {
    const slug = (url.searchParams.get('slug') || '').toLowerCase();
    const kind = (url.searchParams.get('kind') || 'member').toLowerCase();
    const returnTo = url.searchParams.get('return_to') || '';
    if (!['member', 'admin', 'tenant_signup'].includes(kind)) return htmlError('Invalid kind');
    // tenant_signup is a brand-new club — there's no slug to look up. Other
    // kinds need a slug to scope the user lookup to one tenant.
    if (kind !== 'tenant_signup' && !slug) return htmlError('Missing slug — visit your club\'s subdomain to sign in with Google.');

    const state = await encodeState({ slug, kind, return_to: returnTo });
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`, 302);
  }

  // ── callback: exchange code, find-or-create user, mint JWT ─────────────
  if (action === 'callback') {
    const code = url.searchParams.get('code');
    const stateRaw = url.searchParams.get('state');
    if (!code || !stateRaw) return htmlError('Missing code or state from Google.');

    // Decode the state token (just the payload — we trust the signature)
    let state: Record<string, unknown>;
    try {
      const { verify } = await import('https://deno.land/x/djwt@v3.0.2/mod.ts');
      state = await verify(stateRaw, await getKey()) as Record<string, unknown>;
    } catch { return htmlError('OAuth state expired or tampered with — please retry.'); }

    const slug = String(state.slug || '');
    const kind = String(state.kind || 'member');

    // Exchange code for tokens
    const tokRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: GOOGLE_REDIRECT_URI,
        grant_type: 'authorization_code',
      }).toString(),
    });
    if (!tokRes.ok) return htmlError(`Google rejected the code: ${await tokRes.text()}`);
    const tok = await tokRes.json();

    // Fetch profile (email + sub)
    const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { 'Authorization': `Bearer ${tok.access_token}` },
    });
    if (!profileRes.ok) return htmlError('Couldn\'t fetch Google profile.');
    const profile = await profileRes.json() as { sub: string; email: string; email_verified?: boolean; name?: string };
    if (!profile.email_verified) return htmlError('Your Google email isn\'t verified — sign in with email or phone instead.');

    // tenant_signup: no tenant exists yet — bounce back to the marketing
    // signup page with the Google identity prefilled in the URL hash.
    // signup.html reads it, fills email + name, hides password, and links
    // the new admin row to google_sub via tenant_signup.
    if (kind === 'tenant_signup') {
      const params = new URLSearchParams({
        google_email: profile.email,
        google_name: String(profile.name || ''),
        google_sub: profile.sub,
      });
      return Response.redirect(`https://www.poolsideapp.com/signup.html#${params.toString()}`, 302);
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name').eq('slug', slug).maybeSingle();
    if (!tenant) return htmlError(`Club "${slug}" not found.`);

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;

    if (kind === 'admin') {
      // Find admin: by google_sub first, then email
      let { data: admin } = await sb.from('admin_users')
        .select('id, active, role_template, scopes').eq('tenant_id', tenant.id)
        .eq('google_sub', profile.sub).maybeSingle();
      if (!admin) {
        const r = await sb.from('admin_users')
          .select('id, active, role_template, scopes, google_sub').eq('tenant_id', tenant.id)
          .ilike('email', profile.email).maybeSingle();
        admin = r.data;
        if (admin && !admin.google_sub) {
          // Bind future google sign-ins to this admin row
          await sb.from('admin_users').update({ google_sub: profile.sub }).eq('id', admin.id);
        }
      }
      if (!admin || !admin.active) {
        return htmlError(`No active admin account for ${profile.email} on ${tenant.display_name}. Ask an existing admin to invite you.`);
      }
      const jwt = await create({ alg: 'HS256', typ: 'JWT' }, {
        sub: admin.id, kind: 'tenant_admin',
        tid: tenant.id, slug: tenant.slug,
        exp: getNumericDate(60 * 60 * 24 * 30),
      }, await getKey());
      return Response.redirect(`${clubUrl}/club/admin/#bootstrap=${encodeURIComponent(jwt)}`, 302);
    }

    // Member kind
    let { data: member } = await sb.from('household_members')
      .select('id, active, household_id, google_sub').eq('tenant_id', tenant.id)
      .eq('google_sub', profile.sub).maybeSingle();
    if (!member) {
      const r = await sb.from('household_members')
        .select('id, active, household_id, google_sub').eq('tenant_id', tenant.id)
        .ilike('email', profile.email).maybeSingle();
      member = r.data;
      if (member && !member.google_sub) {
        await sb.from('household_members').update({ google_sub: profile.sub }).eq('id', member.id);
      }
    }
    if (!member || !member.active) {
      // Doug 2026-05-23 hit this trying to sign in as a member while his
      // admin self-signup application was still pending review. The bare
      // "no active membership" message was technically right but dead-
      // ends users. Branch on what we know about the email:
      //   1. Matches an active admin → suggest the admin sign-in surface.
      //   2. Matches a pending application → tell them it's being reviewed.
      //   3. Else → original message + a CTA to the apply page.
      const emailLc = profile.email.toLowerCase();
      const safeEmail = escHtml(profile.email);
      const safeClub  = escHtml(tenant.display_name);

      const { data: adminMatch } = await sb.from('admin_users')
        .select('id').eq('tenant_id', tenant.id).eq('active', true)
        .ilike('email', emailLc).maybeSingle();
      if (adminMatch) {
        const adminLoginUrl = `${clubUrl}/club/admin/login.html`;
        return htmlError(
          `You're listed as an <b>admin</b> at ${safeClub}, not a member. Sign in on the admin page instead.<br><br><span style="color:#64748b;font-size:13px">Signed in as ${safeEmail}.</span>`,
          200,
          { actions: [{ label: 'Sign in as admin →', href: adminLoginUrl }], title: 'Wrong sign-in surface' },
        );
      }

      const { data: pendingApp } = await sb.from('applications')
        .select('id, family_name, payment_method, payment_status, created_at')
        .eq('tenant_id', tenant.id).eq('status', 'pending')
        .ilike('primary_email', emailLc)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (pendingApp) {
        const venmoLine = pendingApp.payment_method === 'venmo'
          ? `Once the board sees your Venmo payment land, they approve + activate your membership in one step — typically within 1–10 days (it's a volunteer-run board).`
          : `The board reviews new applications within 1–10 days (it's a volunteer-run board).`;
        return htmlError(
          `We received your application for <b>${escHtml(pendingApp.family_name)}</b> at ${safeClub}. ${venmoLine}<br><br>You'll get a sign-in link by email + SMS the moment you're approved — no need to keep trying to sign in here.`,
          200,
          { title: 'Application under review' },
        );
      }

      // No match anywhere → this is a new person signing in with Google
      // hoping to join. Redirect them straight to the apply form with
      // their Google profile in the URL hash so name + email are already
      // filled in. Same pattern tenant_signup uses to bootstrap signup.html.
      // Putting the data in the hash (not querystring) keeps PII out of
      // server logs / Referer headers.
      const applyParams = new URLSearchParams({
        prefill: 'google',
        email: profile.email ?? '',
        name:  profile.name  ?? '',
      });
      return Response.redirect(`${clubUrl}/apply.html#${applyParams.toString()}`, 302);
    }
    const jwt = await create({ alg: 'HS256', typ: 'JWT' }, {
      sub: member.id, kind: 'member',
      tid: tenant.id, hid: member.household_id, slug: tenant.slug,
      exp: getNumericDate(60 * 60 * 24 * 30),
    }, await getKey());
    return Response.redirect(`${clubUrl}/m/verify.html#bootstrap=${encodeURIComponent(jwt)}`, 302);
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

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
// Google requires the registered redirect URI to match the one we send
// EXACTLY — including query string. Cloud Console registers the bare URL,
// so we can't append ?action=callback. Detect callback by presence of the
// `code` parameter Google appends instead.
const GOOGLE_REDIRECT_URI  = Deno.env.get('GOOGLE_REDIRECT_URI')
  || `${SUPABASE_URL}/functions/v1/google_oauth`;

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
function htmlError(msg: string, status = 400) {
  return new Response(`<!doctype html><meta charset="utf-8"><title>Sign-in error</title>
    <body style="font-family:Inter,system-ui,sans-serif;max-width:480px;margin:60px auto;padding:0 20px;color:#0f172a">
    <h1 style="font-family:Georgia,serif;color:#0a3b5c">Sign-in problem</h1>
    <p>${msg}</p><p><a href="javascript:history.back()">← Go back</a></p></body>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

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

  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return htmlError('Google sign-in isn\'t configured yet — ask the club admin to wire GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.', 503);
  }

  // ── init: redirect to Google ───────────────────────────────────────────
  if (action === 'init') {
    const slug = (url.searchParams.get('slug') || '').toLowerCase();
    const kind = (url.searchParams.get('kind') || 'member').toLowerCase();
    const returnTo = url.searchParams.get('return_to') || '';
    if (!slug) return htmlError('Missing slug — visit your club\'s subdomain to sign in with Google.');
    if (!['member', 'admin'].includes(kind)) return htmlError('Invalid kind');

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
      return htmlError(`No active membership for ${profile.email} at ${tenant.display_name}. Apply for membership first or ask the board to add you.`);
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

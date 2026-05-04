// =============================================================================
// google_drive_sync — admin-side Drive connect + sync orchestration
// =============================================================================
// Auth: tenant admin (HS256, kind='tenant_admin'). Only owners + admins with
// the 'payments' scope can connect/disconnect (it's payment-archive setup).
//
// Append-only by design: NO action exists to delete from Drive. Disconnect
// only revokes our access locally; the user's Drive content is untouched.
//
// Actions:
//   { action: 'status' }
//     → { ok, connected, email, last_sync_at, last_error, pending_in_queue,
//         drive_root_link, spreadsheet_link }
//   { action: 'connect_url' }
//     → { ok, url }   admin redirects browser there; Google bounces back to
//                     this same function with action=callback&code=…&state=…
//   { action: 'callback', code, state }    (called by browser via redirect)
//     → 302 redirect to admin /club/admin/payments.html#drive=connected
//   { action: 'disconnect' }
//     → { ok }        clears refresh_token; Drive content untouched
//   { action: 'test_sync', application_id }
//     → { ok, ...syncResult }   admin can manually re-trigger sync of one app
//   { action: 'retry_queue' }
//     → { ok, attempted, succeeded, failed }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify, create as jwtCreate, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { syncApplicationToDrive, enqueueDriveSync } from '../_shared/sync_application.ts';

const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET    = Deno.env.get('ADMIN_JWT_SECRET');
const GOOGLE_ID     = Deno.env.get('GOOGLE_CLIENT_ID');
const GOOGLE_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type AdminPayload = { sub: string; kind: string; tid: string; slug: string; scopes?: string[]; role_template?: string; is_super?: boolean };
async function importHmacKey(secret: string) {
  return await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
  );
}
async function verifyAdmin(token: string): Promise<AdminPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await importHmacKey(JWT_SECRET);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as AdminPayload;
  } catch { return null; }
}
function hasPaymentsScopeFromJwt(p: AdminPayload): boolean {
  if (p.is_super) return true;
  if (p.role_template === 'owner') return true;
  return Array.isArray(p.scopes) && p.scopes.includes('payments');
}
// JWT-first, DB-fallback. Old tokens (issued before role_template/scopes
// were embedded in the payload) lack those fields; we fall back to a DB
// lookup so they still work without forcing re-login.
async function hasPaymentsScope(sb: ReturnType<typeof createClient>, p: AdminPayload): Promise<boolean> {
  if (hasPaymentsScopeFromJwt(p)) return true;
  if (p.role_template !== undefined && p.scopes !== undefined) return false;
  const { data: admin } = await sb.from('admin_users')
    .select('role_template, scopes, is_super, active').eq('id', p.sub).maybeSingle();
  if (!admin || !admin.active) return false;
  if (admin.is_super) return true;
  if (admin.role_template === 'owner') return true;
  const scopes = (admin.scopes as string[] | null) ?? [];
  return scopes.includes('payments');
}

// State token signed with our JWT secret. Carries tenant_id + admin_id +
// short expiry. Verified on the OAuth callback so we know who initiated.
async function signState(tenantId: string, adminId: string): Promise<string> {
  const key = await importHmacKey(JWT_SECRET!);
  return await jwtCreate(
    { alg: 'HS256', typ: 'JWT' },
    { tid: tenantId, aid: adminId, exp: getNumericDate(60 * 15) },
    key,
  );
}
async function verifyState(tok: string): Promise<{ tid: string; aid: string } | null> {
  try {
    const key = await importHmacKey(JWT_SECRET!);
    const p = await verify(tok, key) as Record<string, unknown>;
    if (!p.tid || !p.aid) return null;
    return { tid: String(p.tid), aid: String(p.aid) };
  } catch { return null; }
}

function redirectUri(_req: Request): string {
  // Use the public Supabase URL — req.url inside the edge runtime reflects
  // the INTERNAL routing (http://, no /functions/v1/ prefix) which doesn't
  // match what's registered in Google Cloud Console.
  return `${SUPABASE_URL}/functions/v1/google_drive_sync`;
}

// Kick off the OAuth flow with drive.file scope (least-privilege — only
// files Poolside creates). We also include offline access + prompt=consent
// so we always get a refresh_token (Google omits it on subsequent grants).
function buildAuthUrl(state: string, redirect: string): string {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', GOOGLE_ID!);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('scope', [
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/userinfo.email',
  ].join(' '));
  u.searchParams.set('state', state);
  return u.toString();
}

async function exchangeCode(code: string, redirect: string): Promise<{ refresh_token?: string; access_token: string }> {
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_ID!,
    client_secret: GOOGLE_SECRET!,
    redirect_uri: redirect,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  return await res.json();
}

async function fetchEmail(accessToken: string): Promise<string | null> {
  try {
    const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.email as string) ?? null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  // Browser-redirect callback — Google sends the user back here as GET.
  // Detect by presence of `code` (Google appends it on success). The bare
  // redirect URI matches what's registered in Cloud Console.
  if (req.method === 'GET') {
    const u = new URL(req.url);
    const code  = u.searchParams.get('code');
    const state = u.searchParams.get('state');
    if (!code) {
      return new Response('Not found', { status: 404, headers: cors });
    }
    if (!state || !GOOGLE_ID || !GOOGLE_SECRET) {
      return new Response('Missing state or platform Google OAuth not configured', { status: 400, headers: cors });
    }
    const stateData = await verifyState(state);
    if (!stateData) return new Response('Invalid or expired state', { status: 401, headers: cors });
    const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
    try {
      const { refresh_token, access_token } = await exchangeCode(code, redirectUri(req));
      if (!refresh_token) {
        return new Response('Google did not return a refresh_token. Try revoking access at https://myaccount.google.com/permissions and reconnecting.', { status: 500, headers: cors });
      }
      const email = await fetchEmail(access_token);
      // Upsert grant (handles reconnect with different account cleanly)
      await sb.from('google_drive_grants').upsert({
        tenant_id: stateData.tid,
        refresh_token,
        connected_email: email,
        connected_at: new Date().toISOString(),
        last_error: null,
        // Reset cached IDs on (re)connect: a different account won't see the old folders
        root_folder_id: null,
        club_folder_id: null,
        spreadsheet_id: null,
        year_folder_ids: {},
        year_tab_ids: {},
      });
      const { data: tenant } = await sb.from('tenants').select('slug').eq('id', stateData.tid).maybeSingle();
      const adminUrl = tenant?.slug
        ? `https://${tenant.slug}.poolsideapp.com/club/admin/payments.html#drive=connected`
        : '/club/admin/payments.html#drive=connected';
      return Response.redirect(adminUrl, 302);
    } catch (e) {
      return new Response(`OAuth exchange failed: ${(e as Error).message}`, { status: 500, headers: cors });
    }
  }

  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  if (!(await hasPaymentsScope(sb, payload))) {
    return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);
  }

  // ── status ──────────────────────────────────────────────────────────────
  if (action === 'status') {
    const platformOk = !!(GOOGLE_ID && GOOGLE_SECRET);
    const { data: grant } = await sb.from('google_drive_grants')
      .select('connected_email, last_sync_at, last_error, root_folder_id, spreadsheet_id, connected_at')
      .eq('tenant_id', payload.tid).maybeSingle();
    const { count: queuePending } = await sb.from('drive_sync_queue')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', payload.tid).eq('status', 'pending');
    return jsonResponse({
      ok: true,
      platform_configured: platformOk,
      connected: !!grant,
      email: grant?.connected_email ?? null,
      connected_at: grant?.connected_at ?? null,
      last_sync_at: grant?.last_sync_at ?? null,
      last_error:   grant?.last_error ?? null,
      pending_in_queue: queuePending ?? 0,
      drive_root_link:  grant?.root_folder_id ? `https://drive.google.com/drive/folders/${grant.root_folder_id}` : null,
      spreadsheet_link: grant?.spreadsheet_id ? `https://docs.google.com/spreadsheets/d/${grant.spreadsheet_id}/edit` : null,
    });
  }

  if (action === 'connect_url') {
    if (!GOOGLE_ID || !GOOGLE_SECRET) {
      return jsonResponse({ ok: false, error: 'Platform Google OAuth not configured (GOOGLE_CLIENT_ID/SECRET)' }, 503);
    }
    const state = await signState(payload.tid, payload.sub);
    return jsonResponse({ ok: true, url: buildAuthUrl(state, redirectUri(req)) });
  }

  // disconnect — clears tokens locally. Does NOT delete anything from Drive.
  if (action === 'disconnect') {
    await sb.from('google_drive_grants').delete().eq('tenant_id', payload.tid);
    return jsonResponse({ ok: true, message: 'Disconnected. Your Drive folder + PDFs were left untouched.' });
  }

  if (action === 'test_sync') {
    const appId = String(body.application_id ?? '').trim();
    if (!appId) return jsonResponse({ ok: false, error: 'application_id required' }, 400);
    if (!GOOGLE_ID || !GOOGLE_SECRET) return jsonResponse({ ok: false, error: 'Platform Google OAuth not configured' }, 503);
    try {
      const r = await syncApplicationToDrive(sb, {
        tenantId: payload.tid, applicationId: appId,
        googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SECRET,
      });
      if (!r.ok) {
        await enqueueDriveSync(sb, payload.tid, appId, r.error);
        return jsonResponse({ ok: false, error: r.error });
      }
      return jsonResponse(r);
    } catch (e) {
      const msg = (e as Error).message;
      await enqueueDriveSync(sb, payload.tid, appId, msg);
      return jsonResponse({ ok: false, error: msg }, 500);
    }
  }

  if (action === 'backfill_unsynced') {
    if (!GOOGLE_ID || !GOOGLE_SECRET) return jsonResponse({ ok: false, error: 'Platform Google OAuth not configured' }, 503);
    // Find applications that have NO drive_sync_log entry yet — these are
    // either pre-Drive-connect applications or ones that errored without
    // queueing. Re-run sync for each.
    const { data: apps } = await sb.from('applications')
      .select('id, family_name, created_at')
      .eq('tenant_id', payload.tid)
      .order('created_at', { ascending: true });
    const { data: synced } = await sb.from('drive_sync_log')
      .select('application_id').eq('tenant_id', payload.tid);
    const syncedSet = new Set((synced ?? []).map(s => s.application_id as string));
    const missing = (apps ?? []).filter(a => !syncedSet.has(a.id as string));
    let attempted = 0, succeeded = 0, failed = 0;
    const errors: Array<{ family: string; error: string }> = [];
    for (const app of missing) {
      attempted++;
      try {
        const r = await syncApplicationToDrive(sb, {
          tenantId: payload.tid, applicationId: app.id as string,
          googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SECRET,
        });
        if (r.ok) succeeded++;
        else { failed++; errors.push({ family: app.family_name as string, error: r.error }); }
      } catch (e) {
        failed++;
        errors.push({ family: app.family_name as string, error: (e as Error).message });
      }
    }
    return jsonResponse({ ok: true, total_unsynced: missing.length, attempted, succeeded, failed, errors });
  }

  if (action === 'retry_queue') {
    if (!GOOGLE_ID || !GOOGLE_SECRET) return jsonResponse({ ok: false, error: 'Platform Google OAuth not configured' }, 503);
    const { data: rows } = await sb.from('drive_sync_queue')
      .select('id, application_id, attempts')
      .eq('tenant_id', payload.tid).eq('status', 'pending')
      .lte('next_retry_at', new Date().toISOString())
      .limit(25);
    let attempted = 0, succeeded = 0, failed = 0;
    for (const row of rows ?? []) {
      attempted++;
      try {
        const r = await syncApplicationToDrive(sb, {
          tenantId: payload.tid, applicationId: row.application_id as string,
          googleClientId: GOOGLE_ID, googleClientSecret: GOOGLE_SECRET,
        });
        if (r.ok) {
          await sb.from('drive_sync_queue').update({ status: 'done' }).eq('id', row.id as string);
          succeeded++;
        } else {
          failed++;
          const attempts = (row.attempts as number ?? 0) + 1;
          const nextAt = new Date(Date.now() + Math.min(60 * 60 * 1000, 60_000 * 2 ** attempts)).toISOString();
          await sb.from('drive_sync_queue').update({
            attempts,
            last_error: r.error,
            next_retry_at: nextAt,
            status: attempts >= 6 ? 'failed' : 'pending',
          }).eq('id', row.id as string);
        }
      } catch (e) {
        failed++;
        const attempts = (row.attempts as number ?? 0) + 1;
        await sb.from('drive_sync_queue').update({
          attempts,
          last_error: (e as Error).message,
          next_retry_at: new Date(Date.now() + 60_000 * 2 ** attempts).toISOString(),
          status: attempts >= 6 ? 'failed' : 'pending',
        }).eq('id', row.id as string);
      }
    }
    return jsonResponse({ ok: true, attempted, succeeded, failed });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

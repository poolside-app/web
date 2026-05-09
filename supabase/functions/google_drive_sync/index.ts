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
import { getAccessToken, formatYearTab, loadGrant } from '../_shared/google_drive.ts';
import { verifyTenantAdminOrProvider, requireSuper } from '../_shared/auth.ts';
import { sendEmail, escHtml } from '../_shared/send_email.ts';

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

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── Provider-side actions (super only) ──────────────────────────────────
  // Doug's /admin/index.html lists pending Drive access requests across all
  // tenants and approves them. Provider tokens come from /admin/login.html
  // and don't carry a tenant scope, so verifyTenantAdminOrProvider
  // synthesizes a super-shaped payload.
  if (action.startsWith('super_')) {
    const sp = await verifyTenantAdminOrProvider(req);
    if (!sp) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
    if (!(await requireSuper(sb, sp))) return jsonResponse({ ok: false, error: 'Provider access required' }, 403);

    if (action === 'super_list_access_requests') {
      const { data, error } = await sb.from('settings')
        .select('tenant_id, value, tenants:tenant_id(slug, display_name)')
        .not('value->drive_access_request', 'is', null);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      const requests = (data ?? []).map(r => {
        const v = r.value as Record<string, unknown> | null;
        const req = (v?.drive_access_request as Record<string, unknown> | undefined);
        if (!req) return null;
        const t = (r as { tenants?: { slug: string; display_name: string } }).tenants;
        return {
          tenant_id: r.tenant_id,
          tenant_slug: t?.slug ?? null,
          tenant_display_name: t?.display_name ?? null,
          status: req.status ?? null,
          requested_at: req.requested_at ?? null,
          requested_by_email: req.requested_by_email ?? null,
          resolved_at: req.resolved_at ?? null,
        };
      }).filter(Boolean);
      return jsonResponse({ ok: true, requests });
    }

    if (action === 'super_set_access_status') {
      const targetTenant = String(body.tenant_id ?? '').trim();
      const newStatus    = String(body.status ?? '').trim();
      if (!targetTenant) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
      if (!['approved', 'denied'].includes(newStatus)) {
        return jsonResponse({ ok: false, error: 'Invalid status' }, 400);
      }
      const { data: existing } = await sb.from('settings')
        .select('value').eq('tenant_id', targetTenant).maybeSingle();
      const value = ((existing?.value as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      const prev = (value.drive_access_request as Record<string, unknown> | undefined) ?? {};
      value.drive_access_request = {
        ...prev,
        status: newStatus,
        resolved_at: new Date().toISOString(),
        resolved_by: sp.sub,
      };
      if (existing) {
        await sb.from('settings').update({ value }).eq('tenant_id', targetTenant);
      } else {
        await sb.from('settings').insert({ tenant_id: targetTenant, value });
      }

      // Email the requesting admin on approval so they know to come back
      // and click Connect. We deliberately don't email on denial — Doug
      // can reach out directly if he wants to explain.
      if (newStatus === 'approved') {
        try {
          const requestedBy = prev.requested_by_email as string | undefined;
          const { data: tenant } = await sb.from('tenants')
            .select('slug, display_name').eq('id', targetTenant).maybeSingle();
          if (requestedBy && tenant) {
            const slug = tenant.slug as string;
            const name = (tenant.display_name as string) || slug;
            await sendEmail({
              to: requestedBy,
              subject: `Google Drive access approved — ${name}`,
              html: `
                <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px;color:#0f172a">
                  <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 12px">✅ Drive access approved</h2>
                  <p style="margin:0 0 12px;line-height:1.55">Hi — you can now connect Google Drive for <b>${escHtml(name)}</b> without seeing the "this app is being tested" warning.</p>
                  <p style="margin:18px 0"><a href="https://${escHtml(slug)}.poolsideapp.com/club/admin/payments.html#drive" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Connect Drive →</a></p>
                  <p style="margin:14px 0 0;color:#94a3b8;font-size:12px">Once Google's verification finishes (4–6 weeks), this approval step will go away for everyone.</p>
                </div>
              `,
            });
          }
        } catch (e) { console.error('drive.access approve notify (non-fatal):', (e as Error).message); }
      }
      return jsonResponse({ ok: true, status: newStatus });
    }

    return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
  }

  // ── Tenant-side actions ─────────────────────────────────────────────────
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

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
    // Drive access-request state — interim gate while Google OAuth
    // verification is pending. UI uses this to decide whether to show the
    // Request button, the Pending state, or the Connect button.
    const { data: settings } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    const reqState = ((settings?.value as Record<string, unknown> | undefined)?.drive_access_request as Record<string, unknown> | undefined) ?? null;
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
      access_request: reqState ? {
        status: reqState.status ?? null,
        requested_at: reqState.requested_at ?? null,
        resolved_at: reqState.resolved_at ?? null,
      } : null,
    });
  }

  // ── request_access ──────────────────────────────────────────────────────
  // Tenant admin clicks "Request Drive access" while Google OAuth is in
  // verification. We store a request record on settings.value, email Doug
  // with the admin's email pre-formatted for paste-into-Test-Users, and the
  // tenant UI flips to a "Pending" state until super_set_access_status
  // approves. This unblocks the unverified-warning hurdle for the first ~100
  // beta clubs without anyone seeing the scary screen.
  if (action === 'request_access') {
    const { data: existing } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    const value = ((existing?.value as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    const prev = (value.drive_access_request as Record<string, unknown> | undefined);
    if (prev && prev.status === 'approved') {
      return jsonResponse({ ok: true, status: 'approved', already: true });
    }
    if (prev && prev.status === 'pending') {
      return jsonResponse({ ok: true, status: 'pending', already: true });
    }

    const { data: admin } = await sb.from('admin_users')
      .select('email, display_name').eq('id', payload.sub).maybeSingle();
    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name').eq('id', payload.tid).maybeSingle();
    const now = new Date().toISOString();

    value.drive_access_request = {
      status: 'pending',
      requested_at: now,
      requested_by_admin_id: payload.sub,
      requested_by_email: admin?.email ?? null,
      requested_by_name: admin?.display_name ?? null,
    };
    if (existing) {
      await sb.from('settings').update({ value }).eq('tenant_id', payload.tid);
    } else {
      await sb.from('settings').insert({ tenant_id: payload.tid, value });
    }

    // Email Doug. Subject + body shaped so he can copy the email into
    // Google Cloud Console Test Users in two clicks.
    try {
      const slug = tenant?.slug ?? payload.slug ?? '';
      const name = (tenant?.display_name as string) || slug;
      const adminEmail = admin?.email ?? '(unknown — check admin_users)';
      await sendEmail({
        to: 'doug@poolsideapp.com',
        subject: `Drive access request — ${name}`,
        html: `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;padding:24px;color:#0f172a">
            <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 12px">📁 Drive access request</h2>
            <p style="margin:0 0 12px;line-height:1.55"><b>${escHtml(name)}</b> (${escHtml(slug)}) wants to connect Google Drive.</p>
            <p style="margin:0 0 6px;color:#475569;font-size:14px">Admin email to paste into Test Users:</p>
            <pre style="background:#f7f3eb;border:1px solid #e5e7eb;border-radius:8px;padding:10px 14px;font-size:14px;margin:0 0 14px;user-select:all">${escHtml(adminEmail)}</pre>
            <ol style="margin:0 0 14px;padding-left:20px;color:#475569;line-height:1.6;font-size:14px">
              <li>Open <a href="https://console.cloud.google.com/apis/credentials/consent">Google Cloud Console → OAuth consent screen → Audience</a></li>
              <li>Click "Add users" under Test users, paste the email above, save</li>
              <li>Click Approve below — they get an email to Connect</li>
            </ol>
            <p style="margin:18px 0"><a href="https://www.poolsideapp.com/admin/index.html#drive-requests" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open provider admin →</a></p>
            <p style="margin:14px 0 0;color:#94a3b8;font-size:12px">Once Google's verification clears (4–6 weeks), this manual step goes away.</p>
          </div>
        `,
      });
    } catch (e) { console.error('drive.access request notify (non-fatal):', (e as Error).message); }

    return jsonResponse({ ok: true, status: 'pending' });
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

  // reformat_tabs — re-applies styling to all year tabs in this tenant's
  // spreadsheet. Used after a formatting upgrade so existing tabs pick up
  // the new look without re-syncing every application.
  if (action === 'reformat_tabs') {
    if (!GOOGLE_ID || !GOOGLE_SECRET) {
      return jsonResponse({ ok: false, error: 'Platform Google OAuth not configured' }, 503);
    }
    const grant = await loadGrant(sb, payload.tid);
    if (!grant || !grant.spreadsheet_id) {
      return jsonResponse({ ok: false, error: 'Drive not connected or no spreadsheet yet' }, 400);
    }
    const accessToken = await getAccessToken(grant.refresh_token, GOOGLE_ID, GOOGLE_SECRET);
    const tabs = grant.year_tab_ids ?? {};
    const reformatted: string[] = [];
    const failed: Array<{ year: string; error: string }> = [];
    for (const [year, sheetId] of Object.entries(tabs)) {
      try {
        await formatYearTab(accessToken, grant.spreadsheet_id as string, sheetId as number);
        reformatted.push(year);
      } catch (e) {
        failed.push({ year, error: (e as Error).message });
      }
    }
    return jsonResponse({ ok: true, reformatted, failed });
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

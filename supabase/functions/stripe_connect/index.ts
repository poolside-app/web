// =============================================================================
// stripe_connect — onboard a tenant's own Stripe account (Standard Connect)
// =============================================================================
// Standard Connect = the tenant has their own Stripe dashboard, charges
// land in their account directly, Poolside takes an `application_fee_amount`
// per charge as the platform fee.
//
// Admin actions (tenant_admin JWT):
//   { action: 'status' }
//     → { ok, connected, charges_enabled, payouts_enabled, account_id }
//
//   { action: 'onboard', return_url? }
//     → { ok, url }  (admin redirects browser there; Stripe brings them back)
//
//   { action: 'refresh_link' }
//     → { ok, url }  (re-issues a fresh onboarding URL if they bailed earlier)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const STRIPE_KEY   = Deno.env.get('STRIPE_SECRET_KEY');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type Payload = { sub: string; kind: string; tid: string; slug: string };
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

// Thin Stripe client. Form-encoded POST with secret-key auth.
async function stripe(path: string, params: Record<string, string | string[]>): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string }> {
  if (!STRIPE_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) v.forEach(x => body.append(k + '[]', x));
    else body.append(k, v);
  }
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message || `Stripe ${res.status}` };
    return { ok: true, data };
  } catch (e) { return { ok: false, error: String(e) }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyTenantAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: tenant } = await sb.from('tenants')
    .select('id, slug, display_name, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled')
    .eq('id', payload.tid).maybeSingle();
  if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

  if (action === 'status') {
    return jsonResponse({
      ok: true,
      connected: !!tenant.stripe_account_id,
      account_id: tenant.stripe_account_id,
      charges_enabled: !!tenant.stripe_charges_enabled,
      payouts_enabled: !!tenant.stripe_payouts_enabled,
      stripe_configured: !!STRIPE_KEY,
    });
  }

  if (action === 'onboard' || action === 'refresh_link') {
    // OWNER ONLY: connecting a Stripe account routes all the club's money
    // through it. A scoped admin should never be able to redirect funds.
    const { requireOwner } = await import('../_shared/auth.ts');
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can connect or change Stripe accounts' }, 403);
    }
    if (!STRIPE_KEY) return jsonResponse({ ok: false, error: 'Stripe not configured on the platform yet (STRIPE_SECRET_KEY missing)' }, 503);

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const returnUrl  = String(body.return_url || `${clubUrl}/club/admin/settings.html#stripe=connected`);
    const refreshUrl = `${clubUrl}/club/admin/settings.html#stripe=retry`;

    let accountId = tenant.stripe_account_id;
    if (!accountId) {
      // Look up the calling admin's email so Stripe can pre-fill the
      // owner email during onboarding. If we can't resolve it for any
      // reason, omit the email field entirely — Stripe will collect it
      // during the hosted onboarding flow. (Passing empty string fails
      // Stripe's stricter 2026 validation.)
      const { data: admin } = await sb.from('admin_users')
        .select('email').eq('id', payload.sub).maybeSingle();
      const adminEmail = admin?.email && /@/.test(String(admin.email)) ? String(admin.email) : null;

      const params: Record<string, string> = {
        type: 'standard',
        'metadata[tenant_id]': tenant.id,
        'metadata[tenant_slug]': tenant.slug,
        'business_profile[name]': tenant.display_name,
      };
      if (adminEmail) params.email = adminEmail;

      const acctRes = await stripe('/accounts', params);
      if (!acctRes.ok) return jsonResponse({ ok: false, error: acctRes.error }, 500);
      accountId = (acctRes.data as { id: string }).id;
      await sb.from('tenants').update({ stripe_account_id: accountId }).eq('id', tenant.id);
    }

    // Get an onboarding link the admin can follow in their browser
    const linkRes = await stripe('/account_links', {
      account: accountId!,
      return_url: returnUrl,
      refresh_url: refreshUrl,
      type: 'account_onboarding',
    });
    if (!linkRes.ok) return jsonResponse({ ok: false, error: linkRes.error }, 500);
    return jsonResponse({ ok: true, url: (linkRes.data as { url: string }).url, account_id: accountId });
  }

  if (action === 'sync') {
    // Re-fetch the account from Stripe and store charges_enabled / payouts_enabled
    if (!tenant.stripe_account_id) return jsonResponse({ ok: false, error: 'Not connected yet' }, 400);
    if (!STRIPE_KEY) return jsonResponse({ ok: false, error: 'Stripe not configured' }, 503);
    const res = await fetch(`https://api.stripe.com/v1/accounts/${tenant.stripe_account_id}`, {
      headers: { 'Authorization': `Bearer ${STRIPE_KEY}` },
    });
    const data = await res.json();
    if (!res.ok) return jsonResponse({ ok: false, error: data?.error?.message || 'Stripe sync failed' }, 500);
    await sb.from('tenants').update({
      stripe_charges_enabled: !!data.charges_enabled,
      stripe_payouts_enabled: !!data.payouts_enabled,
    }).eq('id', tenant.id);
    return jsonResponse({
      ok: true,
      charges_enabled: !!data.charges_enabled,
      payouts_enabled: !!data.payouts_enabled,
    });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

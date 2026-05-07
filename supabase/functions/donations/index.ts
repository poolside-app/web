// =============================================================================
// donations — fundraiser contributions (Stripe Checkout + manual entry)
// =============================================================================
// Public actions (no auth):
//   { action: 'start_checkout', slug, amount_cents, donor_name?, donor_email?,
//     message?, is_public?, is_anonymous? }
//     → { ok, url }   redirect URL for Stripe Checkout
//   { action: 'list_public', slug, limit? }
//     → { ok, recent: [...], top: [...], totals: { count, raised_cents } }
//
// Admin actions (tenant_admin):
//   { action: 'list', status? }                  → all donations
//   { action: 'add_manual', amount_cents, ... }  → record Venmo/cash/check
//   { action: 'update', id, patch }              → flip public/anonymous,
//                                                  fix typos, mark refunded
//   { action: 'delete', id }                     → admin error correction
//
// All write paths recompute settings.value.fundraiser.raised_cents from
// SUM(amount_cents) WHERE status='verified'. The thermometer reads that
// field via tenant_public, so the bar moves the moment a donation lands.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyTenantAdmin } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_KEY   = Deno.env.get('STRIPE_SECRET_KEY') || '';
const FEE_BPS_DONATIONS = 0;  // donations are 0% per pricing memory

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

// Recompute the fundraiser total stored on settings.value.fundraiser.raised_cents.
// Called after every donation insert/update/delete so the thermometer the
// public reads always matches the verified-donation sum.
async function recomputeFundraiserTotal(sb: ReturnType<typeof createClient>, tenantId: string): Promise<number> {
  const { data: rows } = await sb.from('donations')
    .select('amount_cents').eq('tenant_id', tenantId).eq('status', 'verified');
  const total = (rows ?? []).reduce((acc, r) => acc + (r.amount_cents as number), 0);
  const { data: row } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const v = (row?.value as Record<string, unknown> | null) ?? {};
  const fund = (v.fundraiser as Record<string, unknown> | undefined) ?? {};
  const next = { ...v, fundraiser: { ...fund, raised_cents: total } };
  await sb.from('settings').update({ value: next }).eq('tenant_id', tenantId);
  return total;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  // ── start_checkout (public) ──────────────────────────────────────────
  // Creates a Stripe Checkout session in the tenant's connected account.
  // Donor info goes into session.metadata; the stripe_webhook handler
  // unpacks it on checkout.session.completed and inserts the donation
  // row. We don't insert here — only confirmed payments get rows.
  if (action === 'start_checkout') {
    if (!STRIPE_KEY) return jsonResponse({ ok: false, error: 'Card payments aren\'t set up yet' }, 503);
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const amount_cents = Math.round(Number(body.amount_cents) || 0);
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    if (amount_cents < 100) return jsonResponse({ ok: false, error: 'Minimum donation is $1' }, 400);
    if (amount_cents > 100000000) return jsonResponse({ ok: false, error: 'Amount too large' }, 400);

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, stripe_account_id, stripe_charges_enabled')
      .eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (!tenant.stripe_account_id || !tenant.stripe_charges_enabled) {
      return jsonResponse({ ok: false, error: 'This club hasn\'t finished setting up card payments yet — try Venmo instead.' }, 400);
    }

    const donor_name  = String(body.donor_name  ?? '').trim().slice(0, 120) || null;
    const donor_email = String(body.donor_email ?? '').trim().toLowerCase().slice(0, 200) || null;
    const message     = String(body.message     ?? '').trim().slice(0, 500) || null;
    const is_public    = body.is_public    === false ? false : true;
    const is_anonymous = body.is_anonymous === true;

    // Fundraiser title for the Stripe line item description (so the donor's
    // card statement reads as "$50 — Resurfacing Fund" not just "$50").
    const { data: settingsRow } = await sb.from('settings')
      .select('value').eq('tenant_id', tenant.id).maybeSingle();
    const fundCfg = ((settingsRow?.value as Record<string, unknown> | undefined)?.fundraiser as Record<string, unknown> | undefined) ?? {};
    const fundTitle = (fundCfg.title as string) || 'Club Fund';

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const platformFee = Math.max(0, Math.floor(amount_cents * FEE_BPS_DONATIONS / 10000));

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${clubUrl}/?donated=1`);
    params.append('cancel_url',  `${clubUrl}/?donated=0`);
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', `Donation — ${fundTitle}`);
    params.append('line_items[0][price_data][product_data][description]', `Donation to ${tenant.display_name}`);
    params.append('line_items[0][price_data][unit_amount]', String(amount_cents));
    params.append('line_items[0][quantity]', '1');
    if (platformFee > 0) params.append('payment_intent_data[application_fee_amount]', String(platformFee));
    if (donor_email) params.append('customer_email', donor_email);
    params.append('metadata[kind]', 'donation');
    params.append('metadata[tenant_id]', tenant.id as string);
    if (donor_name)  params.append('metadata[donor_name]',  donor_name);
    if (donor_email) params.append('metadata[donor_email]', donor_email);
    if (message)     params.append('metadata[message]',     message);
    params.append('metadata[is_public]',    String(is_public));
    params.append('metadata[is_anonymous]', String(is_anonymous));

    try {
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Account': tenant.stripe_account_id as string,
        },
        body: params.toString(),
      });
      const data = await res.json();
      if (!res.ok) {
        return jsonResponse({ ok: false, error: data?.error?.message || `Stripe ${res.status}` }, 500);
      }
      return jsonResponse({ ok: true, url: data.url, session_id: data.id });
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e) }, 500);
    }
  }

  // ── list_public (no auth) — for the home-page leaderboard ────────────
  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const lim = Math.min(50, Math.max(1, Number(body.limit) || 8));
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Not found' }, 404);

    const baseFilter = sb.from('donations')
      .select('id, amount_cents, donor_name, message, is_anonymous, method, created_at')
      .eq('tenant_id', tenant.id).eq('status', 'verified').eq('is_public', true);

    const { data: recent } = await baseFilter
      .order('created_at', { ascending: false }).limit(lim);
    const { data: top } = await sb.from('donations')
      .select('id, amount_cents, donor_name, message, is_anonymous, method, created_at')
      .eq('tenant_id', tenant.id).eq('status', 'verified').eq('is_public', true)
      .order('amount_cents', { ascending: false }).limit(5);

    // Totals across ALL verified donations (public + private), for the
    // donor count + thermometer match.
    const { data: allVerified } = await sb.from('donations')
      .select('amount_cents').eq('tenant_id', tenant.id).eq('status', 'verified');
    const count = (allVerified ?? []).length;
    const raised_cents = (allVerified ?? []).reduce((acc, r) => acc + (r.amount_cents as number), 0);

    return jsonResponse({
      ok: true,
      recent: (recent ?? []).map(d => publicShape(d)),
      top:    (top    ?? []).map(d => publicShape(d)),
      totals: { count, raised_cents },
    });
  }

  // ── admin actions (tenant_admin token required) ──────────────────────
  const payload = await verifyTenantAdmin(req);
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  if (action === 'list') {
    const status = String(body.status ?? '').trim();
    let q = sb.from('donations')
      .select('id, amount_cents, donor_name, donor_email, message, method, is_public, is_anonymous, status, stripe_session_id, created_at, verified_at')
      .eq('tenant_id', payload.tid).order('created_at', { ascending: false }).limit(500);
    if (status && ['verified','pending','refunded'].includes(status)) q = q.eq('status', status);
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, donations: data ?? [] });
  }

  if (action === 'add_manual') {
    const amount_cents = Math.round(Number(body.amount_cents) || 0);
    if (amount_cents < 100) return jsonResponse({ ok: false, error: 'Minimum donation is $1' }, 400);
    const method = String(body.method ?? 'venmo');
    if (!['venmo','cash','check','paypal','other'].includes(method)) {
      return jsonResponse({ ok: false, error: 'Invalid method' }, 400);
    }
    const row = {
      tenant_id: payload.tid,
      amount_cents,
      donor_name:  String(body.donor_name  ?? '').trim().slice(0, 120) || null,
      donor_email: String(body.donor_email ?? '').trim().toLowerCase().slice(0, 200) || null,
      message:     String(body.message     ?? '').trim().slice(0, 500) || null,
      method,
      is_public:    body.is_public    === false ? false : true,
      is_anonymous: body.is_anonymous === true,
      status: 'verified',
      recorded_by: payload.sub,
    };
    const { data, error } = await sb.from('donations').insert(row).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const total = await recomputeFundraiserTotal(sb, payload.tid as string);
    return jsonResponse({ ok: true, id: data.id, raised_cents: total });
  }

  if (action === 'update') {
    const id = String(body.id ?? '');
    const patch = (body.patch as Record<string, unknown>) || {};
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const cleaned: Record<string, unknown> = {};
    if (patch.donor_name  !== undefined) cleaned.donor_name  = String(patch.donor_name  || '').trim().slice(0, 120) || null;
    if (patch.donor_email !== undefined) cleaned.donor_email = String(patch.donor_email || '').trim().toLowerCase().slice(0, 200) || null;
    if (patch.message     !== undefined) cleaned.message     = String(patch.message     || '').trim().slice(0, 500) || null;
    if (patch.is_public    !== undefined) cleaned.is_public    = !!patch.is_public;
    if (patch.is_anonymous !== undefined) cleaned.is_anonymous = !!patch.is_anonymous;
    if (patch.status !== undefined) {
      const s = String(patch.status);
      if (!['verified','pending','refunded'].includes(s)) {
        return jsonResponse({ ok: false, error: 'Invalid status' }, 400);
      }
      cleaned.status = s;
    }
    if (patch.amount_cents !== undefined) {
      const n = Math.round(Number(patch.amount_cents) || 0);
      if (n < 1) return jsonResponse({ ok: false, error: 'Amount must be > 0' }, 400);
      cleaned.amount_cents = n;
    }
    const { error } = await sb.from('donations').update(cleaned).eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const total = await recomputeFundraiserTotal(sb, payload.tid as string);
    return jsonResponse({ ok: true, raised_cents: total });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('donations').delete().eq('id', id).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const total = await recomputeFundraiserTotal(sb, payload.tid as string);
    return jsonResponse({ ok: true, raised_cents: total });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// Public-display shape — strips email + private fields, applies anonymous
// rule (donor name overridden to null when is_anonymous=true).
function publicShape(d: Record<string, unknown>) {
  return {
    id: d.id,
    amount_cents: d.amount_cents,
    donor_name: d.is_anonymous ? null : (d.donor_name ?? null),
    message: d.message ?? null,
    method: d.method,
    created_at: d.created_at,
  };
}

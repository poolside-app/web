// =============================================================================
// stripe_checkout — create a Checkout session for an application / program /
// guest pass / party. Charges land on the tenant's connected Stripe account
// (Standard Connect); Poolside takes a platform application_fee_amount.
// =============================================================================
// Public actions (no auth — application checkout):
//   { action: 'application', application_id }
//     → { ok, url }
//
// Member actions (member JWT):
//   { action: 'program_booking', booking_id }
//     → { ok, url }
//   { action: 'guest_pass_pack', pack_id }
//     → { ok, url }
//
// Admin actions (tenant_admin JWT):
//   { action: 'admin_application', application_id }   — admin-initiated link
//
// All sessions specify an `application_fee_amount` per Poolside's tier
// (memory: 0.5% dues, 1.5% programs/snack, 2% tickets, 0% donations,
// 5% late fees). For now we use a flat 1.5% fee — refine later.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const STRIPE_KEY   = Deno.env.get('STRIPE_SECRET_KEY');

const PLATFORM_FEE_BPS = 150;  // 1.5% (basis points)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (!p.sub || !p.tid) return null;
    return p;
  } catch { return null; }
}

async function stripeCheckout(params: {
  tenantStripeAccount: string;
  amountCents: number;
  productName: string;
  description?: string;
  successUrl: string;
  cancelUrl: string;
  metadata: Record<string, string>;
  customerEmail?: string;
}): Promise<{ ok: boolean; url?: string; session_id?: string; error?: string }> {
  if (!STRIPE_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  const platformFee = Math.max(0, Math.floor(params.amountCents * PLATFORM_FEE_BPS / 10000));
  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('success_url', params.successUrl);
  body.append('cancel_url', params.cancelUrl);
  body.append('line_items[0][price_data][currency]', 'usd');
  body.append('line_items[0][price_data][product_data][name]', params.productName);
  if (params.description) body.append('line_items[0][price_data][product_data][description]', params.description);
  body.append('line_items[0][price_data][unit_amount]', String(params.amountCents));
  body.append('line_items[0][quantity]', '1');
  body.append('payment_intent_data[application_fee_amount]', String(platformFee));
  if (params.customerEmail) body.append('customer_email', params.customerEmail);
  for (const [k, v] of Object.entries(params.metadata)) body.append(`metadata[${k}]`, v);

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': params.tenantStripeAccount,  // route to the connected account
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message || `Stripe ${res.status}` };
    return { ok: true, url: data.url, session_id: data.id };
  } catch (e) { return { ok: false, error: String(e) }; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── application: public action — anyone with the application id can pay
  if (action === 'application') {
    const id = String(body.application_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'application_id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, family_name, primary_name, primary_email, payment_status, tier_slug, status')
      .eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') return jsonResponse({ ok: false, error: 'Already paid' }, 409);

    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name, stripe_account_id, stripe_charges_enabled').eq('id', app.tenant_id).maybeSingle();
    if (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled) {
      return jsonResponse({ ok: false, error: 'This club hasn\'t finished connecting Stripe yet' }, 400);
    }

    // Resolve tier price from settings
    const { data: settings } = await sb.from('settings').select('value').eq('tenant_id', app.tenant_id).maybeSingle();
    const tiers = ((settings?.value as Record<string, unknown> | undefined)?.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
    const tier = tiers.find(t => t.slug === app.tier_slug) || tiers[0];
    const amountCents = (tier?.price_cents as number) || 0;
    if (amountCents <= 0) return jsonResponse({ ok: false, error: 'Membership fee not configured for this tier' }, 400);

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const session = await stripeCheckout({
      tenantStripeAccount: tenant.stripe_account_id,
      amountCents,
      productName: `${tenant.display_name} — Annual membership (${(tier?.label as string) || 'family'})`,
      description: `Application from ${app.family_name} (${app.primary_name})`,
      successUrl: `${clubUrl}/apply.html?paid=1`,
      cancelUrl: `${clubUrl}/apply.html?paid=0`,
      metadata: {
        kind: 'application',
        application_id: app.id,
        tenant_id: String(app.tenant_id),
      },
      customerEmail: app.primary_email || undefined,
    });
    if (!session.ok) return jsonResponse({ ok: false, error: session.error }, 500);

    await sb.from('applications').update({ stripe_session_id: session.session_id }).eq('id', app.id);
    return jsonResponse({ ok: true, url: session.url });
  }

  // ── application_plan: public action — pay first installment + save card.
  // Creates a payment_plans row + 2 installments, then a Checkout session
  // with mode=payment + setup_future_usage=off_session so the card sticks
  // for the second auto-charge on the final due date.
  if (action === 'application_plan') {
    const id = String(body.application_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'application_id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, family_name, primary_name, primary_email, primary_phone, payment_status, tier_slug, status')
      .eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') return jsonResponse({ ok: false, error: 'Already paid' }, 409);

    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name, stripe_account_id, stripe_charges_enabled').eq('id', app.tenant_id).maybeSingle();
    if (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled) {
      return jsonResponse({ ok: false, error: 'This club hasn\'t finished connecting Stripe yet' }, 400);
    }

    const { data: settings } = await sb.from('settings').select('value').eq('tenant_id', app.tenant_id).maybeSingle();
    const sv = settings?.value as Record<string, unknown> | undefined;
    const tiers = (sv?.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
    const tier = tiers.find(t => t.slug === app.tier_slug) || tiers[0];
    const totalCents = (tier?.price_cents as number) || 0;
    if (totalCents <= 0) return jsonResponse({ ok: false, error: 'Membership fee not configured for this tier' }, 400);

    const planConfig = ((sv?.payments as Record<string, unknown> | undefined)?.plan as Record<string, unknown> | undefined);
    if (!planConfig?.enabled || !planConfig.final_due_date) {
      return jsonResponse({ ok: false, error: 'Payment plans not enabled for this club' }, 400);
    }
    const cutoff = planConfig.plan_signup_cutoff_date as string | null;
    const today = new Date().toISOString().slice(0, 10);
    if (cutoff && today > cutoff) {
      return jsonResponse({ ok: false, error: 'Payment plan signup window has closed; please pay in full' }, 400);
    }
    const pct = Math.max(1, Math.min(99, Number(planConfig.first_installment_pct) || 50));
    const firstCents = Math.round(totalCents * pct / 100);
    const secondCents = totalCents - firstCents;
    const finalDueDate = String(planConfig.final_due_date);

    // Create plan + installments now (idempotently — no double-create on retry)
    const { data: existingPlan } = await sb.from('payment_plans').select('id, status')
      .eq('application_id', id).maybeSingle();
    let planId: string;
    if (existingPlan && existingPlan.status === 'active') {
      planId = existingPlan.id as string;
    } else {
      const { data: newPlan, error: planErr } = await sb.from('payment_plans').insert({
        tenant_id: app.tenant_id,
        application_id: id,
        plan_type: 'two_installment',
        total_cents: totalCents,
        status: 'active',
        primary_email: app.primary_email,
        primary_phone: app.primary_phone,
        family_name: app.family_name,
      }).select('id').single();
      if (planErr || !newPlan) return jsonResponse({ ok: false, error: planErr?.message || 'plan create failed' }, 500);
      planId = newPlan.id as string;
      await sb.from('payment_plan_installments').insert([
        {
          plan_id: planId, tenant_id: app.tenant_id,
          sequence: 1, due_date: today, amount_cents: firstCents, status: 'pending',
        },
        {
          plan_id: planId, tenant_id: app.tenant_id,
          sequence: 2, due_date: finalDueDate, amount_cents: secondCents, status: 'pending',
        },
      ]);
    }

    // Stripe Checkout — mode=payment + setup_future_usage=off_session so we
    // can charge the second installment without the member returning.
    const platformFee = Math.max(0, Math.floor(firstCents * PLATFORM_FEE_BPS / 10000));
    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', `${clubUrl}/apply.html?plan_started=1`);
    params.append('cancel_url',  `${clubUrl}/apply.html?plan_started=0`);
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]',
      `${tenant.display_name} dues — installment 1 of 2 (${(tier?.label as string) || 'family'})`);
    params.append('line_items[0][price_data][product_data][description]',
      `Installment 2 of $${(secondCents / 100).toFixed(2)} will auto-charge on ${finalDueDate}.`);
    params.append('line_items[0][price_data][unit_amount]', String(firstCents));
    params.append('line_items[0][quantity]', '1');
    params.append('payment_intent_data[application_fee_amount]', String(platformFee));
    params.append('payment_intent_data[setup_future_usage]', 'off_session');
    params.append('customer_creation', 'always');
    if (app.primary_email) params.append('customer_email', app.primary_email as string);
    params.append('metadata[kind]', 'payment_plan_first');
    params.append('metadata[plan_id]', planId);
    params.append('metadata[application_id]', id);
    params.append('metadata[tenant_id]', String(app.tenant_id));

    try {
      const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_KEY}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Account': tenant.stripe_account_id,
        },
        body: params.toString(),
      });
      const data = await res.json();
      if (!res.ok) return jsonResponse({ ok: false, error: data?.error?.message || `Stripe ${res.status}` }, 500);
      // Stamp installment 1 with the session id so the webhook can match it
      await sb.from('payment_plan_installments').update({
        stripe_session_id: data.id,
      }).eq('plan_id', planId).eq('sequence', 1);
      return jsonResponse({ ok: true, url: data.url, plan_id: planId, first_cents: firstCents, second_cents: secondCents, second_due: finalDueDate });
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e) }, 500);
    }
  }

  // ── member-authenticated checkout for programs / passes / parties
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyToken(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = String(payload.tid);

  const { data: tenant } = await sb.from('tenants')
    .select('slug, display_name, stripe_account_id, stripe_charges_enabled').eq('id', TID).maybeSingle();
  if (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled) {
    return jsonResponse({ ok: false, error: 'Stripe isn\'t connected for this club yet' }, 400);
  }
  const clubUrl = `https://${tenant.slug}.poolsideapp.com`;

  if (action === 'program_booking') {
    const id = String(body.booking_id ?? '');
    const { data: bk } = await sb.from('program_bookings')
      .select('id, tenant_id, program_id, paid, participant_name').eq('id', id).maybeSingle();
    if (!bk || bk.tenant_id !== TID) return jsonResponse({ ok: false, error: 'Booking not found' }, 404);
    if (bk.paid) return jsonResponse({ ok: false, error: 'Already paid' }, 409);
    const { data: prog } = await sb.from('programs').select('name, price_cents').eq('id', bk.program_id).maybeSingle();
    const amountCents = (prog?.price_cents as number) || 0;
    if (amountCents <= 0) return jsonResponse({ ok: false, error: 'Program is free or unpriced' }, 400);
    const session = await stripeCheckout({
      tenantStripeAccount: tenant.stripe_account_id,
      amountCents,
      productName: `${prog?.name || 'Program'} — ${bk.participant_name}`,
      successUrl: `${clubUrl}/m/?paid=1`,
      cancelUrl: `${clubUrl}/m/?paid=0`,
      metadata: { kind: 'program_booking', booking_id: bk.id, tenant_id: TID },
    });
    if (!session.ok) return jsonResponse({ ok: false, error: session.error }, 500);
    await sb.from('program_bookings').update({ stripe_session_id: session.session_id }).eq('id', bk.id);
    return jsonResponse({ ok: true, url: session.url });
  }

  if (action === 'guest_pass_pack') {
    const id = String(body.pack_id ?? '');
    const { data: pack } = await sb.from('guest_pass_packs')
      .select('id, tenant_id, paid, label, price_cents').eq('id', id).maybeSingle();
    if (!pack || pack.tenant_id !== TID) return jsonResponse({ ok: false, error: 'Pack not found' }, 404);
    if (pack.paid) return jsonResponse({ ok: false, error: 'Already paid' }, 409);
    if ((pack.price_cents as number) <= 0) return jsonResponse({ ok: false, error: 'Pack is free or unpriced' }, 400);
    const session = await stripeCheckout({
      tenantStripeAccount: tenant.stripe_account_id,
      amountCents: pack.price_cents as number,
      productName: `Guest passes — ${pack.label}`,
      successUrl: `${clubUrl}/m/?paid=1`,
      cancelUrl: `${clubUrl}/m/?paid=0`,
      metadata: { kind: 'guest_pass_pack', pack_id: pack.id, tenant_id: TID },
    });
    if (!session.ok) return jsonResponse({ ok: false, error: session.error }, 500);
    await sb.from('guest_pass_packs').update({ stripe_session_id: session.session_id }).eq('id', pack.id);
    return jsonResponse({ ok: true, url: session.url });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

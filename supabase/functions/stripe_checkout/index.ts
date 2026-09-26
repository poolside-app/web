// =============================================================================
// stripe_checkout — create a Checkout session for an application / program /
// party. Charges land on the tenant's connected Stripe account
// (Standard Connect); Poolside takes a platform application_fee_amount.
// =============================================================================
// Public actions (no auth — application checkout):
//   { action: 'application', application_id }
//     → { ok, url }
//
// Member actions (member JWT):
//   { action: 'program_booking', booking_id }
//     → { ok, url }
//
// Admin actions (tenant_admin JWT):
//   { action: 'admin_application', application_id }   — admin-initiated link
//
// All sessions specify an `application_fee_amount` per Poolside's tier:
// 1% dues, 1.5% programs/snack, 2% tickets, 0% donations, 5% late fees.
// Rates live in _shared/fees.ts — never inline them here.
//
// Test payments (settings.payments.test_mode): every action above returns a
// /pay-test.html URL instead of a Stripe one, and nothing reaches Stripe.
//   { action: 'simulate_complete', token }  → { ok, redirect }
// posts a synthetic checkout.session.completed to stripe_webhook, so every
// downstream automation runs exactly as it would for a real card payment.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, getNumericDate, verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const STRIPE_KEY   = Deno.env.get('STRIPE_SECRET_KEY');

// Per-kind platform fee (basis points). Source of truth for "what does
// Poolside charge?" — referenced by both stripe_checkout and payment_plans.
// Pricing: 1% dues (raised from 0.5% on 2026-09-08), 1.5% programs/snack,
// 2% tickets, 0% donations, 5% late fees. The dues rate MUST match the one
// payment_plans uses for installments + reactivation, so a family pays the
// same fee whether it pays in full or over the season.
// Rates live in _shared/fees.ts — they were duplicated across this file and
// three literals in payment_plans, so a change here alone silently missed
// every installment payment.
import { FEE_BPS, planFeeSchedule, feePolicyFromTenant, type FeePolicy } from '../_shared/fees.ts';
import { fmtPoolDate, poolToday, zoneOrDefault } from '../_shared/pool_time.ts';
const FEE_BPS_DUES     = FEE_BPS.dues;
const FEE_BPS_PROGRAMS = FEE_BPS.programs;
const FEE_BPS_DEFAULT  = FEE_BPS.default;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

async function jwtKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET!),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function verifyToken(token: string): Promise<Record<string, unknown> | null> {
  if (!JWT_SECRET) return null;
  try {
    const p = await verify(token, await jwtKey()) as Record<string, unknown>;
    if (!p.sub || !p.tid) return null;
    return p;
  } catch { return null; }
}

async function paymentsTestMode(sb: ReturnType<typeof createClient>, tenantId: string): Promise<boolean> {
  const { data } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const pay = (data?.value as Record<string, unknown> | undefined)?.payments as Record<string, unknown> | undefined;
  return pay?.test_mode === true;
}

type SimCheckout = {
  tid: string; sid: string; amt: number; name: string; desc: string;
  ok: string; no: string; md: Record<string, string>;
};

// The token carries everything the fake checkout needs, signed so the amount
// and metadata can't be edited in the browser. It deliberately has no `sub`:
// several functions accept any signed token with sub + tid as a login.
async function simulatedCheckoutUrl(p: Omit<SimCheckout, 'sid'>): Promise<{ url: string; session_id: string }> {
  const sid = 'sim_cs_' + crypto.randomUUID().replace(/-/g, '');
  const token = await create({ alg: 'HS256', typ: 'JWT' },
    { kind: 'sim_checkout', ...p, sid, exp: getNumericDate(60 * 60) }, await jwtKey());
  return { url: `${new URL(p.ok).origin}/pay-test.html#t=${token}`, session_id: sid };
}

async function verifySimToken(token: string): Promise<SimCheckout | null> {
  if (!JWT_SECRET || !token) return null;
  try {
    const p = await verify(token, await jwtKey()) as Record<string, unknown>;
    if (p.kind !== 'sim_checkout' || !p.tid || !p.sid) return null;
    return p as unknown as SimCheckout;
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
  feeBps: number;       // explicit so the caller picks the right rate per kind
  // Required, not optional. A club with a fee waiver must never be charged
  // because a new call site forgot to opt in — see _shared/fees.ts.
  policy: FeePolicy;
  // Keep the card usable later. Needed for auto-renew: without it Stripe takes
  // the payment and forgets the card, and next season's charge has nothing to
  // charge against.
  saveCard?: boolean;
  simulate: boolean;
}): Promise<{ ok: boolean; url?: string; session_id?: string; error?: string }> {
  if (params.simulate) {
    return { ok: true, ...await simulatedCheckoutUrl({
      tid: params.metadata.tenant_id, amt: params.amountCents,
      name: params.productName, desc: params.description ?? '',
      ok: params.successUrl, no: params.cancelUrl, md: params.metadata,
    }) };
  }
  if (!STRIPE_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  // Applied here rather than at each caller, so one check covers every kind
  // routed through this helper — and again below, where it reaches Stripe.
  const platformFee = params.policy.waived
    ? 0
    : Math.max(0, Math.floor(params.amountCents * params.feeBps / 10000));
  const body = new URLSearchParams();
  body.append('mode', 'payment');
  body.append('success_url', params.successUrl);
  body.append('cancel_url', params.cancelUrl);
  body.append('line_items[0][price_data][currency]', 'usd');
  body.append('line_items[0][price_data][product_data][name]', params.productName);
  if (params.description) body.append('line_items[0][price_data][product_data][description]', params.description);
  body.append('line_items[0][price_data][unit_amount]', String(params.amountCents));
  body.append('line_items[0][quantity]', '1');
  body.append('payment_intent_data[application_fee_amount]',
    String(params.policy.waived ? 0 : platformFee));   // clamped at the boundary
  if (params.customerEmail) body.append('customer_email', params.customerEmail);
  // Metadata twice, deliberately.
  //
  // Session metadata is what stripe_webhook reads when the session completes.
  // But session metadata does NOT propagate to the PaymentIntent or the
  // Charge — and the Charge is the only thing an Application Fee can be
  // traced back to. Without `kind` on the charge, Stripe knows exactly how
  // much we earned from each club and nothing at all about what for, and no
  // amount of later work recovers it: the categorisation has to exist at the
  // moment the charge is created or it never exists.
  for (const [k, v] of Object.entries(params.metadata)) {
    body.append(`metadata[${k}]`, v);
    body.append(`payment_intent_data[metadata][${k}]`, v);
  }
  if (params.saveCard) body.append('payment_intent_data[setup_future_usage]', 'off_session');

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

  // ── simulate_complete: public — the "Pay" button on /pay-test.html
  if (action === 'simulate_complete') {
    const sim = await verifySimToken(String(body.token ?? ''));
    if (!sim) return jsonResponse({ ok: false, error: 'This test checkout has expired — start again' }, 400);
    // Re-checked here, not only when the link was made: turning test mode
    // off has to kill any test links still open in someone's browser.
    if (!(await paymentsTestMode(sb, sim.tid))) {
      return jsonResponse({ ok: false, error: 'Test payments are turned off for this club' }, 403);
    }
    const event = {
      // Derived from the session id, so a double-click replays the same event
      // and stripe_webhook's idempotency check drops the second one.
      id: `evt_${sim.sid}`,
      type: 'checkout.session.completed',
      data: { object: {
        id: sim.sid, object: 'checkout.session',
        status: 'complete', payment_status: 'paid',
        amount_total: sim.amt, currency: 'usd',
        payment_intent: null, customer: null,
        metadata: sim.md,
      } },
    };
    const r = await fetch(`${SUPABASE_URL}/functions/v1/stripe_webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-poolside-internal': SERVICE_ROLE },
      body: JSON.stringify(event),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return jsonResponse({ ok: false, error: `Webhook failed (${r.status}): ${t.slice(0, 200)}` }, 502);
    }
    return jsonResponse({ ok: true, redirect: sim.ok });
  }

  // ── application: public action — anyone with the application id can pay
  if (action === 'application') {
    const id = String(body.application_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'application_id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, family_name, primary_name, primary_email, payment_status, tier_slug, status, is_renewal')
      .eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') return jsonResponse({ ok: false, error: 'Already paid' }, 409);

    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name, stripe_account_id, stripe_charges_enabled, platform_fees_waived, timezone').eq('id', app.tenant_id).maybeSingle();
    const testMode = await paymentsTestMode(sb, app.tenant_id);
    if (!testMode && (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled)) {
      return jsonResponse({ ok: false, error: 'This club hasn\'t finished connecting Stripe yet' }, 400);
    }
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    // Resolve tier price from settings
    const { data: settings } = await sb.from('settings').select('value').eq('tenant_id', app.tenant_id).maybeSingle();
    const sv = (settings?.value as Record<string, unknown> | undefined);
    const tiers = (sv?.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
    const tier = tiers.find(t => t.slug === app.tier_slug) || tiers[0];
    const baseCents = (tier?.price_cents as number) || 0;
    if (baseCents <= 0) return jsonResponse({ ok: false, error: 'Membership fee not configured for this tier' }, 400);

    // Surcharge: if the club has opted to pass the Stripe processing fee to
    // the member, gross up so they net the base price. Net-up formula:
    //   gross = (base + fixed_fee) / (1 - pct_fee)
    // Stripe US default = 2.9% + $0.30. Apply ONLY for the Stripe path
    // (Venmo/check/cash members continue to see the base price).
    const pay = (sv?.payments as Record<string, unknown> | undefined);
    const passFee = !!(pay?.pass_stripe_fee);
    const pct  = Number(pay?.stripe_pct ?? 2.9) / 100;
    const fixed = Number(pay?.stripe_fixed_cents ?? 30);
    let amountCents = baseCents;
    if (passFee) {
      amountCents = Math.ceil((baseCents + fixed) / (1 - pct));
    }

    // A member who ticked "renew me automatically" is agreeing to a future
    // charge, so this is the moment to keep the card.
    let saveCard = false;
    if (app.is_renewal) {
      const { data: appHh } = await sb.from('applications')
        .select('household_id').eq('id', app.id).maybeSingle();
      if (appHh?.household_id) {
        const { data: hh } = await sb.from('households')
          .select('auto_renew').eq('id', appHh.household_id).maybeSingle();
        saveCard = !!hh?.auto_renew;
      }
    }

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const session = await stripeCheckout({
      tenantStripeAccount: tenant.stripe_account_id,
      amountCents,
      productName: `${tenant.display_name} — Annual membership (${(tier?.label as string) || 'family'})${passFee ? ' + processing fee' : ''}`,
      description: `Application from ${app.family_name} (${app.primary_name})`,
      // app_id in the success URL lets the success page issue a fresh
      // magic-link sign-in token immediately (instead of "watch for email").
      // A renewing member is already signed in and belongs in the member
      // portal; only brand-new applicants belong back on the apply form.
      successUrl: app.is_renewal
        ? `${clubUrl}/m/?renewed=1`
        : `${clubUrl}/apply.html?paid=1&app_id=${app.id}`,
      cancelUrl: app.is_renewal
        ? `${clubUrl}/m/renew.html?cancelled=1`
        : `${clubUrl}/apply.html?paid=0`,
      metadata: {
        kind: 'application',
        application_id: app.id,
        tenant_id: String(app.tenant_id),
      },
      customerEmail: app.primary_email || undefined,
      feeBps: FEE_BPS_DUES,
      policy: feePolicyFromTenant(tenant),
      saveCard,
      simulate: testMode,
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
      .select('id, tenant_id, family_name, primary_name, primary_email, primary_phone, payment_status, tier_slug, status, is_renewal')
      .eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') return jsonResponse({ ok: false, error: 'Already paid' }, 409);

    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name, stripe_account_id, stripe_charges_enabled, platform_fees_waived, timezone').eq('id', app.tenant_id).maybeSingle();
    const testMode = await paymentsTestMode(sb, app.tenant_id);
    if (!testMode && (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled)) {
      return jsonResponse({ ok: false, error: 'This club hasn\'t finished connecting Stripe yet' }, 400);
    }
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    // This action builds its Stripe params inline rather than through
    // createCheckoutSession, so the waiver has to be applied by hand below.
    const feePolicy = feePolicyFromTenant(tenant);

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
    // The cutoff and the schedule start are pool dates, not UTC ones.
    const today = poolToday(zoneOrDefault(tenant.timezone));
    if (cutoff && today > cutoff) {
      return jsonResponse({ ok: false, error: 'Payment plan signup window has closed; please pay in full' }, 400);
    }
    // Two shapes share this action. A member who picked a payment count on the
    // renewal page gets a milestone-driven schedule of that length; anyone
    // arriving from the old apply form (no count) keeps the original
    // pay-half-now behavior, so nothing that worked before changes.
    const { resolveRules, generateSchedule, validateSchedule } =
      await import('../_shared/payment_schedule.ts');
    const { data: appYearRow } = await sb.from('applications')
      .select('membership_year').eq('id', id).maybeSingle();
    const planYear = (appYearRow?.membership_year as number | null)
      ?? new Date().getUTCFullYear();

    const wantCount = Math.trunc(Number(body.installment_count) || 0);
    let schedule: Array<{ sequence: number; due_date: string; amount_cents: number }>;

    if (wantCount >= 2) {
      const rules = resolveRules(planConfig, planYear);
      const gen = generateSchedule({ totalCents, rules, count: wantCount, startDate: today });
      if (!gen.ok) return jsonResponse({ ok: false, error: gen.error }, 400);
      // Re-check what we just built. Generation is ours, but the count came
      // from a browser, and money is about to be scheduled against this.
      const check = validateSchedule({ installments: gen.installments, rules, totalCents });
      if (!check.ok) return jsonResponse({ ok: false, error: check.violations[0] }, 400);
      schedule = gen.installments;
    } else {
      const pct = Math.max(1, Math.min(99, Number(planConfig.first_installment_pct) || 50));
      const firstOnly = Math.round(totalCents * pct / 100);
      schedule = [
        { sequence: 1, due_date: today, amount_cents: firstOnly },
        { sequence: 2, due_date: String(planConfig.final_due_date), amount_cents: totalCents - firstOnly },
      ];
    }

    const firstCents = schedule[0].amount_cents;
    const secondCents = totalCents - firstCents;
    const finalDueDate = schedule[schedule.length - 1].due_date;
    const laterCount = schedule.length - 1;

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
        plan_type: schedule.length === 2 ? 'two_installment' : 'custom',
        total_cents: totalCents,
        status: 'active',
        primary_email: app.primary_email,
        primary_phone: app.primary_phone,
        family_name: app.family_name,
      }).select('id').single();
      if (planErr || !newPlan) return jsonResponse({ ok: false, error: planErr?.message || 'plan create failed' }, 500);
      planId = newPlan.id as string;
      // Convenience fee for spreading the payment, fixed now so it cannot
      // move under a family part-way through a season.
      const planFees = planFeeSchedule(schedule.length, feePolicy);
      await sb.from('payment_plan_installments').insert(
        schedule.map((inst, i) => ({
          plan_id: planId, tenant_id: app.tenant_id,
          sequence: inst.sequence,
          // Installment 1 is collected by this Checkout session, so it is due
          // today regardless of where the schedule nominally starts.
          due_date: inst.sequence === 1 ? today : inst.due_date,
          amount_cents: inst.amount_cents,
          plan_fee_cents: planFees[i] ?? 0,
          status: 'pending',
        })),
      );
    }

    // Stripe Checkout — mode=payment + setup_future_usage=off_session so we
    // can charge the second installment without the member returning.
    // The member is charged the dues installment plus its share of the plan
    // fee; application_fee_amount carries our dues cut PLUS the whole plan
    // fee, so the club nets exactly the dues either way.
    const firstPlanFee = planFeeSchedule(schedule.length, feePolicy)[0] ?? 0;
    const firstChargeCents = firstCents + firstPlanFee;
    // firstPlanFee is already 0 under a waiver, but be explicit: a reader
    // should not have to trace planFeeSchedule to see that a waived club
    // is charged nothing at all.
    const platformFee = feePolicy.waived
      ? 0
      : Math.max(0, Math.floor(firstCents * FEE_BPS_DUES / 10000)) + firstPlanFee;
    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const successUrl = app.is_renewal
      ? `${clubUrl}/m/?renewed=1&plan=1`
      : `${clubUrl}/apply.html?plan_started=1&app_id=${id}`;
    const cancelUrl = app.is_renewal
      ? `${clubUrl}/m/renew.html?cancelled=1`
      : `${clubUrl}/apply.html?plan_started=0`;
    const productName = `${tenant.display_name} dues — payment 1 of ${schedule.length} (${(tier?.label as string) || 'family'})`;
    const description = (laterCount === 1
        ? `The remaining $${(secondCents / 100).toFixed(2)} auto-charges on ${finalDueDate}.`
        : `${laterCount} more payments totalling $${(secondCents / 100).toFixed(2)} auto-charge through ${finalDueDate}.`)
      + (firstPlanFee > 0
        ? ` Includes a $${(firstPlanFee / 100).toFixed(2)} payment-plan fee per payment.`
        : '');
    const metadata: Record<string, string> = {
      kind: 'payment_plan_first',
      plan_id: planId,
      application_id: id,
      tenant_id: String(app.tenant_id),
      // application_fee_amount bundles our dues cut and the member's plan
      // fee into a single number, and Stripe has no way to tell them apart
      // afterwards. Record the split now or the breakdown is lost for good.
      fee_plan_cents: String(feePolicy.waived ? 0 : firstPlanFee),
      fee_dues_cents: String(Math.max(0, platformFee - (feePolicy.waived ? 0 : firstPlanFee))),
    };

    if (testMode) {
      const sim = await simulatedCheckoutUrl({
        tid: String(app.tenant_id), amt: firstChargeCents, name: productName, desc: description,
        ok: successUrl, no: cancelUrl, md: metadata,
      });
      await sb.from('payment_plan_installments').update({
        stripe_session_id: sim.session_id,
      }).eq('plan_id', planId).eq('sequence', 1);
      return jsonResponse({ ok: true, url: sim.url, plan_id: planId, first_cents: firstCents, second_cents: secondCents, second_due: finalDueDate });
    }

    const params = new URLSearchParams();
    params.append('mode', 'payment');
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    params.append('line_items[0][price_data][currency]', 'usd');
    params.append('line_items[0][price_data][product_data][name]', productName);
    params.append('line_items[0][price_data][product_data][description]', description);
    params.append('line_items[0][price_data][unit_amount]', String(firstChargeCents));
    params.append('line_items[0][quantity]', '1');
    params.append('payment_intent_data[application_fee_amount]',
      String(feePolicy.waived ? 0 : platformFee));   // clamped at the boundary
    params.append('payment_intent_data[setup_future_usage]', 'off_session');
    params.append('customer_creation', 'always');
    if (app.primary_email) params.append('customer_email', app.primary_email as string);
    // Both places, for the reason in createCheckoutSession above: the
    // session copy is what the webhook reads, the payment_intent copy is what
    // survives onto the Charge and makes the Application Fee categorisable.
    for (const [k, v] of Object.entries(metadata)) {
      params.append(`metadata[${k}]`, v);
      params.append(`payment_intent_data[metadata][${k}]`, v);
    }

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
    .select('slug, display_name, stripe_account_id, stripe_charges_enabled, platform_fees_waived, timezone').eq('id', TID).maybeSingle();
  const testMode = await paymentsTestMode(sb, TID);
  if (!testMode && (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled)) {
    return jsonResponse({ ok: false, error: 'Stripe isn\'t connected for this club yet' }, 400);
  }
  if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
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
      feeBps: FEE_BPS_PROGRAMS,
      policy: feePolicyFromTenant(tenant),
      simulate: testMode,
    });
    if (!session.ok) return jsonResponse({ ok: false, error: session.error }, 500);
    await sb.from('program_bookings').update({ stripe_session_id: session.session_id }).eq('id', bk.id);
    return jsonResponse({ ok: true, url: session.url });
  }

  if (action === 'party_booking') {
    const id = String(body.party_id ?? body.booking_id ?? '');
    const { data: party } = await sb.from('party_bookings')
      .select('id, tenant_id, household_id, title, status, payment_status, price_cents, starts_at')
      .eq('id', id).maybeSingle();
    if (!party || party.tenant_id !== TID) return jsonResponse({ ok: false, error: 'Party not found' }, 404);
    if (party.status !== 'approved') return jsonResponse({ ok: false, error: 'Party must be approved before payment' }, 409);
    if (party.payment_status === 'paid') return jsonResponse({ ok: false, error: 'Already paid' }, 409);
    const amountCents = (party.price_cents as number) || 0;
    if (amountCents <= 0) return jsonResponse({ ok: false, error: 'Party fee not set — ask the board' }, 400);
    // The 2.0% platform fee is taken out of the member's payment as a Stripe
    // Connect application_fee. Stripe's own 2.9%+30¢ is on top of that — by
    // billing the member the gross amount, the club nets the full party fee.
    // Caller can opt to pass `gross_up: true` (default) to include both fees
    // in the displayed price; otherwise the member pays exactly amountCents.
    const dateLabel = fmtPoolDate(party.starts_at as string, zoneOrDefault(tenant.timezone), { dateStyle: 'medium' });
    const session = await stripeCheckout({
      tenantStripeAccount: tenant.stripe_account_id,
      amountCents,
      productName: `Party fee — ${party.title} (${dateLabel})`,
      successUrl: `${clubUrl}/m/index.html?paid=1#parties`,
      cancelUrl: `${clubUrl}/m/index.html?paid=0#parties`,
      metadata: { kind: 'party_booking', party_id: party.id, tenant_id: TID },
      feeBps: FEE_BPS_PROGRAMS,    // 1.5% — parties bucket
      policy: feePolicyFromTenant(tenant),
      simulate: testMode,
    });
    if (!session.ok) return jsonResponse({ ok: false, error: session.error }, 500);
    await sb.from('party_bookings').update({ stripe_session_id: session.session_id }).eq('id', party.id);
    return jsonResponse({ ok: true, url: session.url });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

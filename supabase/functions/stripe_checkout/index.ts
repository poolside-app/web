// =============================================================================
// stripe_checkout — create a Checkout session for an application / program /
// party. Charges land on the tenant's connected Stripe account
// (Standard Connect); Poolside takes a platform application_fee_amount.
// =============================================================================
// Public actions (no auth — application checkout):
//   { action: 'application', application_id }
//     → { ok, url }
//   { action: 'application_plan', application_id, today_cents, payoff_month }
//     → { ok, url }   a payment plan: pays today's share, or only saves the card
//
// Member actions (member JWT):
//   { action: 'program_booking', booking_id }
//     → { ok, url }
//   { action: 'plan_card' | 'plan_payoff' | 'plan_reinstate' }   — their payment plan
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
import { FEE_BPS, feePolicyFromTenant, platformFeeCents, type FeePolicy } from '../_shared/fees.ts';
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

/**
 * A $0 membership: run it through stripe_webhook as a completed payment, the
 * same way test payments do, so approval, the household, emails, the referral
 * check and the discount record all happen exactly as for a card. The webhook
 * records it as payment_method 'free', with no card and no Stripe session.
 */
async function confirmFree(
  app: Record<string, unknown>, tenant: Record<string, unknown>,
): Promise<{ ok: true; redirect: string } | { ok: false; error: string }> {
  const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
  const redirect = app.is_renewal ? `${clubUrl}/m/?renewed=1` : `${clubUrl}/apply.html?paid=1&app_id=${app.id}`;
  const sid = `free_${app.id}`;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/stripe_webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-poolside-internal': SERVICE_ROLE },
    body: JSON.stringify({
      id: `evt_${sid}`,   // one per application, so a double tap does nothing twice
      type: 'checkout.session.completed',
      data: { object: {
        id: sid, object: 'checkout.session', status: 'complete', payment_status: 'paid',
        amount_total: 0, currency: 'usd', payment_intent: null, customer: null,
        metadata: { kind: 'application', application_id: String(app.id), tenant_id: String(app.tenant_id), free: '1' },
      } },
    }),
  });
  if (!r.ok) return { ok: false, error: `Could not confirm (${r.status})` };
  return { ok: true, redirect };
}

/** A Stripe API call on the club's own account. */
async function stripeApi(
  path: string, params: Record<string, string> | URLSearchParams, account: string,
): Promise<{ ok: true; data: Record<string, any> } | { ok: false; error: string }> {
  if (!STRIPE_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': account,
      },
      body: (params instanceof URLSearchParams ? params : new URLSearchParams(params)).toString(),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message || `Stripe ${res.status}` };
    return { ok: true, data };
  } catch (e) { return { ok: false, error: String(e) }; }
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

  // ── confirm_free: public — "Confirm, nothing to pay" (H5). A discount or
  // credit covered the whole price. The price is worked out again here, so
  // this only ever confirms a membership that really is $0.
  if (action === 'confirm_free') {
    const id = String(body.application_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'application_id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, payment_status, is_renewal').eq('id', id).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'Application not found' }, 404);
    if (app.payment_status === 'paid') return jsonResponse({ ok: false, error: 'Already paid' }, 409);
    const { data: tenant } = await sb.from('tenants').select('slug').eq('id', app.tenant_id).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const { priceApplication } = await import('../_shared/membership_price.ts');
    const priced = await priceApplication(sb, id);
    if (!priced || priced.amount_due_cents > 0) {
      return jsonResponse({ ok: false, error: `There's $${((priced?.amount_due_cents ?? 0) / 100).toFixed(2)} to pay.` }, 409);
    }
    const free = await confirmFree(app as Record<string, unknown>, tenant as Record<string, unknown>);
    return jsonResponse(free, free.ok ? 200 : 400);
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

    // The price after any discount and credit (H5), worked out again here so
    // what the card is charged always matches the rules.
    const { data: settings } = await sb.from('settings').select('value').eq('tenant_id', app.tenant_id).maybeSingle();
    const sv = (settings?.value as Record<string, unknown> | undefined);
    const tiers = (sv?.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
    const tier = tiers.find(t => t.slug === app.tier_slug) || tiers[0];
    if (!(Number(tier?.price_cents) > 0)) return jsonResponse({ ok: false, error: 'Membership fee not configured for this tier' }, 400);
    const { priceApplication } = await import('../_shared/membership_price.ts');
    const priced = await priceApplication(sb, app.id as string);
    const baseCents = priced?.amount_due_cents ?? 0;
    if (baseCents <= 0) {
      // Nothing to pay: confirm it like a payment, without a card.
      const free = await confirmFree(app as Record<string, unknown>, tenant as Record<string, unknown>);
      return jsonResponse(free.ok ? { ok: true, url: free.redirect, free: true } : free, free.ok ? 200 : 400);
    }

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
      productName: `${tenant.display_name} — Annual membership (${(tier?.label as string) || 'family'})${
        priced && priced.discount_cents + priced.credit_cents > 0 ? ', after discount' : ''}${passFee ? ' + processing fee' : ''}`,
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

  // ── application_plan: public action — start a payment plan (PLAN.md M).
  // The family chose how much to pay today ($0 included) and the month to be
  // paid off by. The schedule is worked out again here from the stored price,
  // never taken from the browser. With money due today, Stripe's page takes
  // it and keeps the card; with $0 today, Stripe's page only saves the card.
  if (action === 'application_plan') {
    const id = String(body.application_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'application_id required' }, 400);
    const { data: app } = await sb.from('applications')
      .select('id, tenant_id, household_id, family_name, primary_name, primary_email, primary_phone, payment_status, tier_slug, status, is_renewal, membership_year')
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
    const feePolicy = feePolicyFromTenant(tenant);
    const { loadPlanClub } = await import('../_shared/plan_ops.ts');
    const club = await loadPlanClub(sb, app.tenant_id as string);
    if (!club) return jsonResponse({ ok: false, error: 'Club not found' }, 404);

    // Spread what they actually owe after any discount and credit (H5).
    const { priceApplication } = await import('../_shared/membership_price.ts');
    const totalCents = (await priceApplication(sb, app.id as string))?.amount_due_cents ?? 0;
    if (totalCents <= 0) return jsonResponse({ ok: false, error: 'There is nothing left to pay, so there is no plan to set up.', free: true }, 400);

    const { sellingYear } = await import('../_shared/membership_year.ts');
    const year = (app.membership_year as number | null) ?? sellingYear(club.sv);
    const { quotePlan } = await import('../_shared/plan_quote.ts');
    const q = quotePlan(club, {
      totalCents, tierSlug: app.tier_slug as string | null, year, policy: feePolicy,
      todayCents: Number(body.today_cents ?? 0), payoffMonth: String(body.payoff_month ?? ''),
    });
    if (!q.available) return jsonResponse({ ok: false, error: q.reason }, 400);
    if (!q.choice?.ok || !q.choice.rows) {
      return jsonResponse({ ok: false, error: q.choice?.error ?? 'That plan does not work.', min_today_cents: q.choice?.min_today_cents ?? null }, 400);
    }
    if (body.payoff_month && q.choice.payoff_month !== body.payoff_month) {
      return jsonResponse({ ok: false, error: 'Choose a payoff month from the list.' }, 400);
    }
    const rows = q.choice.rows;
    const first = q.choice.today_cents > 0 ? rows[0] : null;
    const later = first ? rows.slice(1) : rows;

    // A family that went back from Stripe and chose again replaces the plan
    // that never started. One that has started is left alone.
    const { data: existing } = await sb.from('payment_plans')
      .select('id, stripe_payment_method_id').eq('application_id', id);
    for (const p of existing ?? []) {
      const { count } = await sb.from('payment_plan_installments').select('id', { count: 'exact', head: true })
        .eq('plan_id', p.id).in('status', ['paid', 'manual']);
      if ((count ?? 0) > 0 || p.stripe_payment_method_id) {
        return jsonResponse({ ok: false, error: 'Your payment plan is already set up. Sign in to see it.' }, 409);
      }
      await sb.from('payment_plan_installments').delete().eq('plan_id', p.id);
      await sb.from('payment_plans').delete().eq('id', p.id);
    }
    const { data: plan, error: planErr } = await sb.from('payment_plans').insert({
      tenant_id: app.tenant_id, application_id: id, household_id: app.household_id ?? null,
      plan_type: 'flex', total_cents: totalCents, status: 'active',
      today_cents: q.choice.today_cents, payoff_month: q.choice.payoff_month,
      primary_email: app.primary_email, primary_phone: app.primary_phone, family_name: app.family_name,
    }).select('id').single();
    if (planErr || !plan) return jsonResponse({ ok: false, error: planErr?.message || 'plan create failed' }, 500);
    const planId = plan.id as string;
    const { error: instErr } = await sb.from('payment_plan_installments').insert(rows.map(r => ({
      plan_id: planId, tenant_id: app.tenant_id, sequence: r.sequence, due_date: r.due_date,
      amount_cents: r.amount_cents, plan_fee_cents: r.plan_fee_cents, card_fee_cents: r.card_fee_cents,
      status: 'pending',
    })));
    if (instErr) {
      await sb.from('payment_plans').delete().eq('id', planId);
      return jsonResponse({ ok: false, error: instErr.message }, 500);
    }
    await sb.from('applications').update({ payment_method: 'stripe_plan' }).eq('id', id);

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const successUrl = app.is_renewal ? `${clubUrl}/m/?renewed=1&plan=1` : `${clubUrl}/apply.html?plan_started=1&app_id=${id}`;
    const cancelUrl = app.is_renewal ? `${clubUrl}/m/renew.html?cancelled=1` : `${clubUrl}/apply.html?plan_started=0`;
    const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
    const day = (d: string) => fmtPoolDate(`${d}T12:00:00Z`, 'UTC', { month: 'short', day: 'numeric' });
    const laterText = later.length
      ? `${later.length} monthly payment${later.length === 1 ? '' : 's'} of about ${usd(later[0].charge_cents)}, ${day(later[0].due_date)} through ${day(later[later.length - 1].due_date)}`
      : '';
    const productName = first
      ? `${tenant.display_name} dues: payment 1 of ${rows.length}`
      : `${tenant.display_name} dues: save your card for your payment plan`;
    const description = first
      ? `Then ${laterText}.`
      : `No charge today. ${laterText.charAt(0).toUpperCase() + laterText.slice(1)}.`;
    const platformFee = !first || feePolicy.waived
      ? 0
      : Math.max(0, Math.floor(first.amount_cents * FEE_BPS_DUES / 10000)) + first.plan_fee_cents;
    const metadata: Record<string, string> = {
      kind: first ? 'payment_plan_first' : 'payment_plan_setup',
      plan_id: planId, application_id: id, tenant_id: String(app.tenant_id),
      fee_plan_cents: String(first && !feePolicy.waived ? first.plan_fee_cents : 0),
      fee_dues_cents: String(first ? Math.max(0, platformFee - (feePolicy.waived ? 0 : first.plan_fee_cents)) : 0),
    };

    if (testMode) {
      const sim = await simulatedCheckoutUrl({
        tid: String(app.tenant_id), amt: first ? first.charge_cents : 0, name: productName, desc: description,
        ok: successUrl, no: cancelUrl, md: metadata,
      });
      if (first) {
        await sb.from('payment_plan_installments').update({ stripe_session_id: sim.session_id }).eq('plan_id', planId).eq('sequence', 1);
      }
      return jsonResponse({ ok: true, url: sim.url, plan_id: planId });
    }

    const params = new URLSearchParams();
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    for (const [k, v] of Object.entries(metadata)) params.append(`metadata[${k}]`, v);
    if (first) {
      params.append('mode', 'payment');
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append('line_items[0][price_data][product_data][name]', productName);
      params.append('line_items[0][price_data][product_data][description]', description);
      params.append('line_items[0][price_data][unit_amount]', String(first.charge_cents));
      params.append('line_items[0][quantity]', '1');
      params.append('payment_intent_data[application_fee_amount]', String(feePolicy.waived ? 0 : platformFee));
      params.append('payment_intent_data[setup_future_usage]', 'off_session');
      params.append('customer_creation', 'always');
      if (app.primary_email) params.append('customer_email', app.primary_email as string);
      for (const [k, v] of Object.entries(metadata)) params.append(`payment_intent_data[metadata][${k}]`, v);
    } else {
      // Saving a card with no charge needs a customer to keep it on.
      const cust = await stripeApi('/customers', {
        ...(app.primary_email ? { email: app.primary_email as string } : {}),
        name: String(app.primary_name || app.family_name || ''),
        'metadata[plan_id]': planId, 'metadata[tenant_id]': String(app.tenant_id),
      }, tenant.stripe_account_id as string);
      if (!cust.ok) return jsonResponse({ ok: false, error: cust.error }, 500);
      await sb.from('payment_plans').update({ stripe_customer_id: cust.data.id }).eq('id', planId);
      params.append('mode', 'setup');
      params.append('customer', cust.data.id as string);
      params.append('currency', 'usd');
      params.append('payment_method_types[0]', 'card');
      params.append('custom_text[submit][message]', description);
      for (const [k, v] of Object.entries(metadata)) params.append(`setup_intent_data[metadata][${k}]`, v);
    }
    const s = await stripeApi('/checkout/sessions', params, tenant.stripe_account_id as string);
    if (!s.ok) return jsonResponse({ ok: false, error: s.error }, 500);
    if (first) {
      await sb.from('payment_plan_installments').update({ stripe_session_id: s.data.id }).eq('plan_id', planId).eq('sequence', 1);
    }
    return jsonResponse({ ok: true, url: s.data.url, plan_id: planId });
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

  // ── A family's own payment plan (PLAN.md M): a new card, paying it off,
  // or coming back after a lapse or cancellation. Every amount is worked out
  // here from the plan's own payments.
  if (action === 'plan_card' || action === 'plan_payoff' || action === 'plan_reinstate') {
    if (payload.kind !== 'member' || !payload.hid) return jsonResponse({ ok: false, error: 'Members only' }, 403);
    const ops = await import('../_shared/plan_ops.ts');
    const club = await ops.loadPlanClub(sb, TID);
    const { data: plans } = await sb.from('payment_plans').select('*')
      .eq('tenant_id', TID).eq('household_id', String(payload.hid)).in('status', ['active', 'lapsed', 'cancelled'])
      .order('created_at', { ascending: false }).limit(1);
    const plan = plans?.[0];
    if (!plan || !club) return jsonResponse({ ok: false, error: 'No payment plan found.' }, 404);
    const rows = await ops.installmentsOf(sb, plan.id as string);
    const unpaid = rows.filter(r => !ops.isPaid(r));
    const policy = feePolicyFromTenant(tenant);
    const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

    let kind = 'payment_plan_catchup';
    let ids: string[] = [];
    let dues = 0, planFees = 0, extra = 0;
    let name = '', desc = '';
    if (action === 'plan_reinstate') {
      if (plan.status === 'active') return jsonResponse({ ok: false, error: 'Your plan is already active.' }, 409);
      const r = ops.reinstateAmount(club, plan, rows);
      ids = r.ids; dues = r.dues_cents; planFees = r.plan_fee_cents; extra = r.fee_cents;
      name = `${tenant.display_name}: reinstate your membership`;
      desc = `${dues ? `Overdue dues ${usd(dues + planFees)}` : 'Nothing overdue'}${extra ? ` plus the ${usd(extra)} reactivation fee` : ''}.`;
    } else if (plan.status !== 'active') {
      return jsonResponse({ ok: false, error: 'Your membership is canceled. Reinstate it first.' }, 409);
    } else if (action === 'plan_payoff') {
      if (!unpaid.length) return jsonResponse({ ok: false, error: 'Your plan is already paid in full.' }, 409);
      kind = 'payment_plan_payoff';
      ids = unpaid.map(r => r.id); dues = unpaid.reduce((n, r) => n + r.amount_cents, 0);
      name = `${tenant.display_name}: pay off your plan`;
      desc = `The rest of your dues, ${usd(dues)}. No more plan fees.`;
    } else {
      const overdue = unpaid.filter(r => r.status === 'retrying' || r.status === 'failed' || r.due_date < club.today);
      if (overdue.length) {
        ids = overdue.map(r => r.id); dues = overdue.reduce((n, r) => n + r.amount_cents, 0);
        planFees = policy.waived ? 0 : overdue.reduce((n, r) => n + Number(r.plan_fee_cents ?? 0), 0);
        name = `${tenant.display_name}: your overdue payment`;
        desc = `Pays what's overdue with your new card, which is used for the rest of your plan.`;
      } else {
        kind = 'payment_plan_card';
      }
    }

    const metadata: Record<string, string> = {
      kind, plan_id: plan.id as string, tenant_id: TID,
      ...(ids.length ? { installment_ids: ids.join(',') } : {}),
      ...(action === 'plan_reinstate' ? { reinstate: '1' } : {}),
    };
    const successUrl = `${clubUrl}/m/?plan=${action === 'plan_card' ? 'card' : action === 'plan_payoff' ? 'paid' : 'back'}#plan`;
    const cancelUrl = `${clubUrl}/m/#plan`;
    const base = dues + planFees + extra;

    // Coming back with nothing owed and no fee: no checkout needed.
    if (kind === 'payment_plan_catchup' && base <= 0) {
      const sid = `free_${plan.id}_${Date.now()}`;
      const r = await fetch(`${SUPABASE_URL}/functions/v1/stripe_webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-poolside-internal': SERVICE_ROLE },
        body: JSON.stringify({ id: `evt_${sid}`, type: 'checkout.session.completed', data: { object: {
          id: sid, object: 'checkout.session', status: 'complete', payment_status: 'paid', amount_total: 0,
          payment_intent: null, customer: null, metadata,
        } } }),
      });
      return r.ok ? jsonResponse({ ok: true, url: successUrl }) : jsonResponse({ ok: false, error: 'Could not reinstate' }, 502);
    }

    const charge = kind === 'payment_plan_card' ? 0 : ops.grossUp(club, base);
    if (testMode) {
      const sim = await simulatedCheckoutUrl({
        tid: TID, amt: charge, name: name || `${tenant.display_name}: update your card`,
        desc: desc || 'Saves a new card for the rest of your payment plan. No charge today.',
        ok: successUrl, no: cancelUrl, md: metadata,
      });
      return jsonResponse({ ok: true, url: sim.url });
    }

    // Keep the new card on the same Stripe customer as the old one.
    let customer = String(plan.stripe_customer_id ?? '');
    if (!customer.startsWith('cus_')) {
      const c = await stripeApi('/customers', {
        ...(plan.primary_email ? { email: plan.primary_email as string } : {}),
        name: String(plan.family_name ?? ''), 'metadata[plan_id]': plan.id as string,
      }, tenant.stripe_account_id as string);
      if (!c.ok) return jsonResponse({ ok: false, error: c.error }, 500);
      customer = c.data.id as string;
      await sb.from('payment_plans').update({ stripe_customer_id: customer }).eq('id', plan.id);
    }
    const params = new URLSearchParams();
    params.append('success_url', successUrl);
    params.append('cancel_url', cancelUrl);
    params.append('customer', customer);
    for (const [k, v] of Object.entries(metadata)) params.append(`metadata[${k}]`, v);
    if (kind === 'payment_plan_card') {
      params.append('mode', 'setup');
      params.append('currency', 'usd');
      params.append('payment_method_types[0]', 'card');
      params.append('custom_text[submit][message]', 'No charge today. Your payment plan uses this card from now on.');
      for (const [k, v] of Object.entries(metadata)) params.append(`setup_intent_data[metadata][${k}]`, v);
    } else {
      const platformFee = policy.waived ? 0 : platformFeeCents(dues, 'dues', policy) + planFees;
      params.append('mode', 'payment');
      params.append('line_items[0][price_data][currency]', 'usd');
      params.append('line_items[0][price_data][product_data][name]', name);
      params.append('line_items[0][price_data][product_data][description]', desc);
      params.append('line_items[0][price_data][unit_amount]', String(charge));
      params.append('line_items[0][quantity]', '1');
      params.append('payment_intent_data[application_fee_amount]', String(policy.waived ? 0 : platformFee));
      // A family paying off the whole plan has no later charges to save a card for.
      if (kind !== 'payment_plan_payoff') params.append('payment_intent_data[setup_future_usage]', 'off_session');
      for (const [k, v] of Object.entries(metadata)) params.append(`payment_intent_data[metadata][${k}]`, v);
    }
    const s = await stripeApi('/checkout/sessions', params, tenant.stripe_account_id as string);
    if (!s.ok) return jsonResponse({ ok: false, error: s.error }, 500);
    return jsonResponse({ ok: true, url: s.data.url });
  }

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
    const feeCents = (party.price_cents as number) || 0;
    if (feeCents <= 0) return jsonResponse({ ok: false, error: 'Party fee not set — ask the board' }, 400);
    // The card fee always goes on the member, never the club (Doug,
    // 2026-10-07): the club nets the whole party fee.
    const { data: payRow } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const pay = ((payRow?.value as Record<string, unknown> | undefined)?.payments as Record<string, unknown> | undefined) ?? {};
    const { partyCardTotal } = await import('../_shared/party_slots.ts');
    const amountCents = partyCardTotal(feeCents, Number(pay.stripe_pct ?? 2.9) / 100, Number(pay.stripe_fixed_cents ?? 30));
    const dateLabel = fmtPoolDate(party.starts_at as string, zoneOrDefault(tenant.timezone), { dateStyle: 'medium' });
    const session = await stripeCheckout({
      tenantStripeAccount: tenant.stripe_account_id,
      amountCents,
      productName: `Party fee — ${party.title} (${dateLabel})`,
      description: `$${(feeCents / 100).toFixed(2)} party fee + $${((amountCents - feeCents) / 100).toFixed(2)} card fee`,
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

// =============================================================================
// payment_plans — split-installment dues + auto-charge + lapse handling
// =============================================================================
// Auth: tenant admin (HS256, 'payments' scope) for admin actions; cron actions
// gated by x-cron-secret header (CRON_SECRET env var).
//
// Actions:
//   { action: 'config_get' }                  → { ok, config }
//   { action: 'config_save', config }         → { ok }
//   { action: 'list_plans', filter? }         → { ok, plans, installments }
//   { action: 'reactivate', plan_id }         → { ok, url }   Stripe Checkout for balance + fee
//   { action: 'simulate_charge', plan_id }    → { ok }        test payments only: the next payment
//   { action: 'member_plan' } (member)        → { ok, plan }
//   { action: 'member_cancel' } (member)      → { ok, plan }  no refund; treated like a lapse
//   { action: 'mark_paid', installment_id, note? } → { ok }   manual override (e.g. cash/check)
//   { action: 'cron_run' }                    → { ok, charged, retried, lapsed, past_deadline, reminded, enforced, ... }
//   { action: 'auto_renew_run' }              → { ok, noticed, charged, failed, skipped }
// =============================================================================

import { platformFeeCents, feePolicyFromTenant, type FeePolicy } from '../_shared/fees.ts';
import { poolDate } from '../_shared/pool_time.ts';
import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL    = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET      = Deno.env.get('ADMIN_JWT_SECRET');
const STRIPE_KEY      = Deno.env.get('STRIPE_SECRET_KEY');
const CRON_SECRET     = Deno.env.get('CRON_SECRET');
const RESEND_API_KEY  = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM     = Deno.env.get('RESEND_FROM') || 'Poolside <noreply@poolsideapp.com>';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type AdminPayload = { sub: string; kind: string; tid: string; slug: string; scopes?: string[]; role_template?: string; is_super?: boolean };
async function verifyAdmin(token: string): Promise<AdminPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as AdminPayload;
  } catch { return null; }
}
type MemberPayload = { sub: string; tid: string; hid: string };
async function verifyMember(token: string): Promise<MemberPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'member' || !p.sub || !p.tid || !p.hid) return null;
    return p as unknown as MemberPayload;
  } catch { return null; }
}
function hasPaymentsScopeFromJwt(p: AdminPayload): boolean {
  if (p.is_super) return true;
  if (p.role_template === 'owner') return true;
  return Array.isArray(p.scopes) && p.scopes.includes('payments');
}
async function hasPaymentsScope(sb: SupabaseClient, p: AdminPayload): Promise<boolean> {
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

// The plan rules (when the gate opens, what a lapse does, how a family comes
// back) live in _shared/plan_ops.ts, shared with checkout and the webhook.
import {
  PLAN_DEFAULTS, planConfig, loadPlanClub, planYear, installmentsOf, isPaid, paidCents, chargeFor,
  grantAccessIfReady, completeIfPaid, endPlan, enforceEnd, seasonStarted, rulesFor, planView,
  memberPlanView, type PlanClub, type PlanConfig, type Inst,
} from '../_shared/plan_ops.ts';

// Stripe API helper — direct charges on Connect Standard, Stripe-Account header
// scopes operations to the tenant's connected account.
async function stripe<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number>,
  stripeAccount: string,
  idempotencyKey?: string,
): Promise<{ ok: boolean; data?: T; error?: string; code?: string }> {
  if (!STRIPE_KEY) return { ok: false, error: 'STRIPE_SECRET_KEY not set' };
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));
  try {
    const res = await fetch(`https://api.stripe.com/v1${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': stripeAccount,
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: body.toString(),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: data?.error?.message || `Stripe ${res.status}`, code: data?.error?.code };
    }
    return { ok: true, data: data as T };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

function escHtml(s: string): string {
  const m: Record<string, string> = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  return s.replace(/[&<>"']/g, c => m[c] || c);
}

async function sendReminderEmail(args: {
  to: string; tenantName: string; familyName: string; amountCents: number;
  dueDate: string; daysUntil: number; signinLink: string;
}): Promise<boolean> {
  if (!RESEND_API_KEY) return false;
  const dollars = (args.amountCents / 100).toFixed(2);
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Payment due ${args.daysUntil === 1 ? 'tomorrow' : `in ${args.daysUntil} days`}</h2>
      <p style="margin:0 0 16px;color:#64748b">Hi ${escHtml(args.familyName)} family — your next ${escHtml(args.tenantName)} payment of <b>$${dollars}</b> is charged on <b>${escHtml(args.dueDate)}</b> to the card on your plan.</p>
      <p style="margin:24px 0">
        <a href="${args.signinLink}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">See my plan</a>
      </p>
    </div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: RESEND_FROM, to: [args.to], subject: `Payment reminder — ${args.tenantName}`, html }),
    });
    return res.ok;
  } catch { return false; }
}

/** Days from one pool date to another. */
function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
}

/** Whether a failed payment is due another try today: the club's retry days
 *  count from the first failure (3, 7 and 14 days by default). */
function retryDue(inst: Inst, cfg: PlanConfig, today: string, tz: string): boolean {
  if (inst.status !== 'retrying') return true;
  if (!inst.first_failed_at) return true;
  const first = poolDate(inst.first_failed_at, tz);
  const n = Math.max(1, Number(inst.attempt_count ?? 1));
  const wait = cfg.retry_days[Math.min(n, cfg.retry_days.length) - 1] ?? 14;
  return daysBetween(first, today) >= wait;
}

/**
 * Charge one payment off-session on the club's Stripe account. Stripe's reply
 * to our own call settles it: a charge we made cannot be faked, so there is
 * nothing for a webhook to add. The idempotency key is per attempt, so a run
 * retried within Stripe's 24 hours can never charge twice.
 */
async function chargeInstallment(
  sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>, inst: Inst, rows: Inst[],
): Promise<{ paid: boolean; exhausted: boolean; error?: string }> {
  const policy: FeePolicy = { waived: club.feesWaived };
  // Never past the plan's total, whatever the rows say.
  if (paidCents(rows) + inst.amount_cents > Number(plan.total_cents)) {
    await sb.from('payment_plan_installments').update({ status: 'manual', last_error: 'Skipped: the plan total was already reached' }).eq('id', inst.id);
    return { paid: false, exhausted: false, error: 'over total' };
  }
  const planFee = policy.waived ? 0 : Number(inst.plan_fee_cents ?? 0);
  const amount = chargeFor(inst, policy.waived);
  const attempts = Number(inst.attempt_count ?? 0) + 1;
  const params: Record<string, string> = {
    amount: String(amount),
    currency: 'usd',
    customer: String(plan.stripe_customer_id),
    payment_method: String(plan.stripe_payment_method_id),
    confirm: 'true',
    off_session: 'true',
    'metadata[plan_id]': String(plan.id),
    'metadata[installment_id]': inst.id,
    'metadata[tenant_id]': club.tenantId,
    'metadata[kind]': 'payment_plan_installment',
    // Split recorded at charge time — application_fee_amount bundles the dues
    // cut with the member's plan fee and Stripe cannot separate them later.
    'metadata[fee_plan_cents]': String(planFee),
    'metadata[fee_dues_cents]': String(policy.waived ? 0 : platformFeeCents(inst.amount_cents, 'dues', policy)),
    // The card fee (if the club passes it on) stays with the club, to cover
    // what Stripe takes.
    application_fee_amount: String(policy.waived ? 0 : platformFeeCents(inst.amount_cents, 'dues', policy) + planFee),
  };
  if (!STRIPE_KEY || !club.stripeAccount) return { paid: false, exhausted: false, error: 'Stripe not set up' };
  let res: Response;
  try {
    res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': club.stripeAccount,
        'Idempotency-Key': `installment_${inst.id}_attempt_${attempts}`,
      },
      body: new URLSearchParams(params).toString(),
    });
  } catch (e) {
    return { paid: false, exhausted: false, error: String(e) };
  }
  const data = await res.json();
  const now = new Date().toISOString();
  if (res.ok && data.status === 'succeeded') {
    await sb.from('payment_plan_installments').update({
      status: 'paid', paid_at: now, stripe_payment_intent_id: data.id,
      attempt_count: attempts, last_attempt_at: now, last_error: null,
    }).eq('id', inst.id);
    inst.status = 'paid';
    await sendReceipt(sb, club, plan, inst, rows, amount);
    return { paid: true, exhausted: false };
  }

  // Declined: one email to the family on the first failure, then quiet
  // retries on the club's retry days. Out of tries ends the plan.
  const errorMsg = String(data?.error?.message || `Stripe ${res.status}`).slice(0, 500);
  const exhausted = attempts > club.cfg.retry_days.length;
  await sb.from('payment_plan_installments').update({
    status: exhausted ? 'failed' : 'retrying',
    attempt_count: attempts, last_attempt_at: now, last_error: errorMsg,
    first_failed_at: inst.first_failed_at ?? now,
  }).eq('id', inst.id);
  if (attempts === 1 && plan.household_id) {
    const { pushMembers } = await import('../_shared/member_notify.ts');
    await pushMembers({ tenant_id: club.tenantId, household_ids: [plan.household_id as string],
      title: 'A payment didn\'t go through', body: 'Update your card in the app and it goes through right away.', url: '/m/#plan', tag: `plan-${plan.id}` });
  }
  if (attempts === 1 && plan.primary_email) {
    try {
      const { renderAndSend } = await import('../_shared/email_template.ts');
      await renderAndSend(sb, {
        tenantId: club.tenantId, templateKey: 'plan_installment_failed', to: plan.primary_email as string,
        variables: {
          family_name: plan.family_name as string,
          amount: '$' + (amount / 100).toFixed(2),
          sequence: String(inst.sequence),
        },
      });
    } catch { /* best-effort */ }
  }
  return { paid: false, exhausted, error: errorMsg };
}

/** The family's receipt for one payment, naming the next one if any: a
 *  pop-up in their app (N6) and the emailed receipt, which is the record. */
async function sendReceipt(
  sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>, inst: Inst, rows: Inst[], amount: number,
): Promise<void> {
  if (plan.household_id) {
    const { pushMembers } = await import('../_shared/member_notify.ts');
    const left = rows.some(r => r.sequence > inst.sequence && !isPaid(r));
    await pushMembers({ tenant_id: club.tenantId, household_ids: [plan.household_id as string],
      title: left ? `Payment received: $${(amount / 100).toFixed(2)}` : 'You\'re paid in full 🎉',
      body: left ? 'Thanks! Your plan is on track.' : `Your ${club.name} dues are paid in full.`, url: '/m/#plan', tag: `plan-${plan.id}` });
  }
  if (!plan.primary_email) return;
  try {
    const { renderAndSend } = await import('../_shared/email_template.ts');
    const next = rows.find(r => r.sequence > inst.sequence && !isPaid(r));
    await renderAndSend(sb, {
      tenantId: club.tenantId,
      templateKey: next ? 'plan_installment_paid_partial' : 'plan_installment_paid_final',
      to: plan.primary_email as string,
      variables: {
        family_name: plan.family_name as string,
        amount: '$' + (amount / 100).toFixed(2),
        sequence: String(inst.sequence),
        next_amount: next ? '$' + (chargeFor(next, club.feesWaived) / 100).toFixed(2) : '',
        next_due_date: next ? next.due_date : '',
      },
    });
  } catch { /* never fail the charge run because of an email */ }
}

/** After a payment lands: the gate if the rule is now met, and done if that
 *  was the last one. */
async function afterPayment(sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>): Promise<void> {
  const rows = await installmentsOf(sb, plan.id as string);
  await grantAccessIfReady(sb, club, plan, { announce: true, rows });
  await completeIfPaid(sb, club, plan, rows);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Cron runner — gated by CRON_SECRET, no admin auth. Drains charges + reminders.

  // ── auto_renew_run (cron) ───────────────────────────────────────────────
  // Two passes, deliberately. Members were told "we'll charge this card when
  // the new season opens and email you first", so the notice is a promise, not
  // a nicety: nobody is charged until they have had `auto_renew_notice_days`
  // to look at the amount and cancel. A silent annual charge is how a club
  // turns a loyal member into an angry one.
  if (action === 'auto_renew_run') {
    const got = req.headers.get('x-cron-secret') || '';
    if (!CRON_SECRET || got !== CRON_SECRET) {
      return jsonResponse({ ok: false, error: 'Bad cron secret' }, 401);
    }
    const { sellingYear, renewalOpen } = await import('../_shared/membership_year.ts');
    const nowIso = new Date().toISOString();
    let noticed = 0, charged = 0, failed = 0, skipped = 0;

    // Trial clubs are running real seasons with real members — only suspended
    // and churned clubs should be skipped.
    const { data: tenants } = await sb.from('tenants')
      .select('id, slug, display_name, status, stripe_account_id, stripe_charges_enabled, platform_fees_waived')
      .not('status', 'in', '("suspended","churned")');

    for (const tenant of (tenants ?? [])) {
      const { data: settingsRow } = await sb.from('settings')
        .select('value').eq('tenant_id', tenant.id).maybeSingle();
      const sv = (settingsRow?.value ?? {}) as Record<string, unknown>;
      if (!renewalOpen(sv)) continue;

      const year = sellingYear(sv);
      const noticeDays = Number(
        ((sv.membership as Record<string, unknown> | undefined)?.auto_renew_notice_days) ?? 7,
      );

      // Dues for the coming season, grossed up if the club passes card fees on.
      const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
      const pay = (sv.payments as Record<string, unknown> | undefined) ?? {};
      const passFee = !!pay.pass_stripe_fee;
      const pct = Number(pay.stripe_pct ?? 2.9) / 100;
      const fixed = Number(pay.stripe_fixed_cents ?? 30);
      const grossUp = (cents: number): number =>
        cents > 0 && passFee ? Math.ceil((cents + fixed) / (1 - pct)) : cents;
      // A family's referral credit comes off first (H5), so the notice and
      // the charge both quote what they actually owe.
      const { priceFor: memberPrice, priceApplication, recordDiscountUse } = await import('../_shared/membership_price.ts');
      const hasPrice = tiers.some(t => Number(t.price_cents) > 0);

      const { data: households } = await sb.from('households')
        .select('id, family_name, tier, paid_until_year, auto_renew_customer_id, auto_renew_pm_id, auto_renew_notice_year, auto_renew_notice_sent_at')
        .eq('tenant_id', tenant.id).eq('active', true).eq('auto_renew', true)
        .or(`paid_until_year.is.null,paid_until_year.lt.${year}`)
        .limit(500);

      for (const hh of (households ?? [])) {
        if (!hasPrice) { skipped++; continue; }
        let amountCents = grossUp((await memberPrice(sb, tenant.id as string, sv, {
          tierSlug: hh.tier as string | null, householdId: hh.id as string, isRenewal: true,
        })).amount_due_cents);

        // Pass 1 — the heads-up.
        if (hh.auto_renew_notice_year !== year) {
          const chargeOn = new Date(Date.now() + noticeDays * 86400_000).toISOString().slice(0, 10);
          const { data: primary } = await sb.from('household_members')
            .select('email').eq('household_id', hh.id).eq('role', 'primary').eq('active', true).maybeSingle();
          if (primary?.email) {
            try {
              const { renderAndSend } = await import('../_shared/email_template.ts');
              await renderAndSend(sb, {
                tenantId: tenant.id as string,
                templateKey: 'auto_renew_notice',
                to: primary.email as string,
                variables: {
                  family_name: hh.family_name as string,
                  amount: '$' + (amountCents / 100).toFixed(2),
                  season: String(year),
                  charge_date: chargeOn,
                  manage_url: `https://${tenant.slug}.poolsideapp.com/m/renew.html`,
                },
              });
            } catch { /* a missing template must not block the renewal */ }
          }
          await sb.from('households').update({
            auto_renew_notice_year: year, auto_renew_notice_sent_at: nowIso,
          }).eq('id', hh.id);
          noticed++;
          continue;   // charge on a later run, after they have had the window
        }

        // Pass 2 — charge, once the notice has had time to land.
        const sentAt = hh.auto_renew_notice_sent_at ? Date.parse(hh.auto_renew_notice_sent_at as string) : 0;
        if (!sentAt || (Date.now() - sentAt) < noticeDays * 86400_000) { skipped++; continue; }
        if (!hh.auto_renew_customer_id || !hh.auto_renew_pm_id) {
          // Opted in but we never captured a reusable card — leave it for the
          // renewal reminders rather than pretending it will charge.
          await sb.from('households').update({
            auto_renew_last_attempt_at: nowIso,
            auto_renew_last_error: 'No saved card on file — member needs to renew manually.',
          }).eq('id', hh.id);
          skipped++; continue;
        }
        if (!tenant.stripe_account_id || !tenant.stripe_charges_enabled) { skipped++; continue; }

        // The renewal application first: it is what carries the season, and
        // what the receipt, audit trail and admin queue all hang off.
        const { data: existing } = await sb.from('applications')
          .select('id').eq('tenant_id', tenant.id).eq('household_id', hh.id)
          .eq('is_renewal', true).eq('membership_year', year)
          .in('status', ['prefilled', 'pending']).maybeSingle();
        let appId = existing?.id as string | undefined;
        if (!appId) {
          const { data: primary } = await sb.from('household_members')
            .select('name, email, phone_e164').eq('household_id', hh.id)
            .eq('role', 'primary').eq('active', true).maybeSingle();
          const { data: created } = await sb.from('applications').insert({
            tenant_id: tenant.id, household_id: hh.id,
            is_renewal: true, is_new_member: false, membership_year: year,
            status: 'pending', payment_status: 'unpaid',
            family_name: hh.family_name,
            primary_name: primary?.name ?? hh.family_name,
            primary_email: primary?.email ?? null,
            primary_phone: primary?.phone_e164 ?? null,
            tier_slug: hh.tier,
          }).select('id').single();
          appId = created?.id as string | undefined;
        }
        if (!appId) { failed++; continue; }

        // The price stored on the renewal is what gets charged.
        const priced = await priceApplication(sb, appId);
        amountCents = grossUp(priced?.amount_due_cents ?? 0);
        if (amountCents <= 0) {
          // Their credit covers the whole season: nothing to charge.
          const nowFree = new Date().toISOString();
          await sb.from('applications').update({
            payment_status: 'paid', payment_method: 'free', paid_at: nowFree, verified_at: nowFree,
            status: 'approved', decided_at: nowFree,
          }).eq('id', appId);
          await recordDiscountUse(sb, appId);
          await sb.from('households').update({
            paid_until_year: Math.max(Number(hh.paid_until_year ?? 0), year),
            dues_paid_for_year: true, auto_renew_last_attempt_at: nowFree, auto_renew_last_error: null,
          }).eq('id', hh.id);
          await sb.from('audit_log').insert({
            tenant_id: tenant.id, kind: 'renewal.auto_charged',
            entity_type: 'application', entity_id: appId,
            summary: `${hh.family_name} renewed through ${year}; their referral credit covered it`,
            actor_kind: 'system', actor_label: 'cron',
          });
          charged++;
          continue;
        }

        const charge = await stripe<{ id: string; status: string }>('/payment_intents', {
          amount: amountCents,
          currency: 'usd',
          customer: hh.auto_renew_customer_id as string,
          payment_method: hh.auto_renew_pm_id as string,
          confirm: 'true',
          off_session: 'true',
          'metadata[kind]': 'application',
          'metadata[application_id]': appId,
          'metadata[tenant_id]': String(tenant.id),
          application_fee_amount: platformFeeCents(amountCents, 'dues', feePolicyFromTenant(tenant)),
          // One try per renewal per day: a run retried the same day can never
          // charge the family twice.
        }, tenant.stripe_account_id as string, `autorenew_${appId}_${nowIso.slice(0, 10)}`);

        if (charge.ok && charge.data?.status === 'succeeded') {
          const now2 = new Date().toISOString();
          await sb.from('applications').update({
            payment_status: 'paid', payment_method: 'stripe',
            paid_at: now2, verified_at: now2, status: 'approved', decided_at: now2,
            stripe_payment_intent_id: charge.data?.id ?? null,
          }).eq('id', appId);
          await recordDiscountUse(sb, appId);
          await sb.from('households').update({
            paid_until_year: Math.max(Number(hh.paid_until_year ?? 0), year),
            dues_paid_for_year: true,
            auto_renew_last_attempt_at: now2,
            auto_renew_last_error: null,
          }).eq('id', hh.id);
          try {
            const { data: primary } = await sb.from('household_members')
              .select('email').eq('household_id', hh.id).eq('role', 'primary').eq('active', true).maybeSingle();
            if (primary?.email) {
              const { renderAndSend } = await import('../_shared/email_template.ts');
              await renderAndSend(sb, {
                tenantId: tenant.id as string,
                templateKey: 'auto_renew_charged',
                to: primary.email as string,
                variables: {
                  family_name: hh.family_name as string,
                  amount: '$' + (amountCents / 100).toFixed(2),
                  season: String(year),
                },
              });
            }
          } catch { /* the money moved; a failed receipt must not undo that */ }

          await sb.from('audit_log').insert({
            tenant_id: tenant.id, kind: 'renewal.auto_charged',
            entity_type: 'application', entity_id: appId,
            summary: `${hh.family_name} auto-renewed through ${year}`,
            actor_kind: 'system', actor_label: 'cron',
          });
          charged++;
        } else {
          // Leave the application open so the member can finish it themselves
          // from the renewal page — a declined card should not cost them a seat.
          await sb.from('households').update({
            auto_renew_last_attempt_at: nowIso,
            auto_renew_last_error: (charge.error || 'Card declined').slice(0, 500),
          }).eq('id', hh.id);
          try {
            const { data: primary } = await sb.from('household_members')
              .select('email').eq('household_id', hh.id).eq('role', 'primary').eq('active', true).maybeSingle();
            if (primary?.email) {
              const { renderAndSend } = await import('../_shared/email_template.ts');
              await renderAndSend(sb, {
                tenantId: tenant.id as string,
                templateKey: 'auto_renew_failed',
                to: primary.email as string,
                variables: {
                  family_name: hh.family_name as string,
                  amount: '$' + (amountCents / 100).toFixed(2),
                  season: String(year),
                  manage_url: `https://${tenant.slug}.poolsideapp.com/m/renew.html`,
                },
              });
            }
          } catch { /* best-effort; the admin task below is the backstop */ }

          await (await import('../_shared/enqueue_task.ts')).enqueueAdminTask(sb, {
            tenant_id: tenant.id as string, target_scopes: ['payments'], kind: 'renewal.auto_renew_failed',
            summary: `Auto-renew failed for ${hh.family_name} — card declined`,
            source_kind: 'household', source_id: hh.id,
          });
          failed++;
        }
      }
    }

    return jsonResponse({ ok: true, noticed, charged, failed, skipped });
  }

  if (action === 'cron_run') {
    const got = req.headers.get('x-cron-secret') || '';
    if (!CRON_SECRET || got !== CRON_SECRET) {
      return jsonResponse({ ok: false, error: 'Bad cron secret' }, 401);
    }
    // Every club's own "today" (pool time), loaded once per club.
    const clubs = new Map<string, PlanClub | null>();
    const clubFor = async (tid: string) => {
      if (!clubs.has(tid)) clubs.set(tid, await loadPlanClub(sb, tid));
      return clubs.get(tid) ?? null;
    };

    // 1. Charge what's due today, and retry failed cards on their retry days.
    //    A test-payment card (sim_) is never sent to Stripe; the board moves
    //    those plans along with "Simulate the next payment".
    let charged = 0, lapsed = 0, retried = 0;
    const { data: activePlans } = await sb.from('payment_plans').select('*').eq('status', 'active').limit(500);
    for (const plan of (activePlans ?? [])) {
      const club = await clubFor(plan.tenant_id as string);
      if (!club) continue;
      const rows = await installmentsOf(sb, plan.id as string);
      const due = rows.filter(r => (r.status === 'pending' || r.status === 'retrying') && r.due_date <= club.today);
      if (!due.length) continue;
      if (!plan.stripe_customer_id || !plan.stripe_payment_method_id) continue;
      if (String(plan.stripe_payment_method_id).startsWith('sim_')) continue;
      if (!club.stripeAccount || !club.chargesEnabled) continue;
      let anyPaid = false;
      for (const inst of due) {
        if (!retryDue(inst, club.cfg, club.today, club.tz)) break;
        if (inst.status === 'retrying') retried++;
        const r = await chargeInstallment(sb, club, plan, inst, rows);
        if (r.paid) { charged++; anyPaid = true; continue; }
        if (r.exhausted) {
          await endPlan(sb, club, plan, 'card_failed');
          lapsed++;
        }
        break;   // one failure at a time; later payments wait for this one
      }
      if (anyPaid && plan.status === 'active') await afterPayment(sb, club, plan);
    }

    // 2. The paid-in-full date: a plan still owing the day after it ends,
    //    and the gate and fobs go off (Doug, 2026-10-07).
    let past_deadline = 0;
    const { data: stillActive } = await sb.from('payment_plans').select('*').eq('status', 'active').limit(500);
    for (const plan of (stillActive ?? [])) {
      const club = await clubFor(plan.tenant_id as string);
      if (!club) continue;
      const rules = rulesFor(club, await planYear(sb, plan));
      const final = rules.milestones[rules.milestones.length - 1]?.date;
      if (!final || club.today <= final) continue;
      const rows = await installmentsOf(sb, plan.id as string);
      if (rows.every(isPaid)) continue;
      await endPlan(sb, club, plan, 'deadline');
      past_deadline++;
    }

    // 3. Reminders before a charge, only for a club that turned them on.
    let reminded = 0;
    const { data: upcoming } = await sb.from('payment_plan_installments')
      .select('*').eq('status', 'pending').gt('due_date', new Date().toISOString().slice(0, 10)).limit(500);
    for (const inst of (upcoming ?? [])) {
      const club = await clubFor(inst.tenant_id as string);
      if (!club || !club.cfg.reminder_days_before.length) continue;
      const daysUntil = daysBetween(club.today, inst.due_date as string);
      const matched = club.cfg.reminder_days_before.find(d => d === daysUntil);
      if (matched === undefined) continue;
      const sentMilestones = (inst.reminder_milestones_sent as string[]) ?? [];
      if (sentMilestones.includes(String(matched))) continue;
      const { data: plan } = await sb.from('payment_plans').select('*').eq('id', inst.plan_id).maybeSingle();
      if (!plan || plan.status !== 'active' || !plan.primary_email) continue;
      const sent = await sendReminderEmail({
        to: plan.primary_email, tenantName: club.name, familyName: plan.family_name as string,
        amountCents: chargeFor(inst as Inst, club.feesWaived), dueDate: inst.due_date as string, daysUntil,
        signinLink: `${club.clubUrl}/m/#plan`,
      });
      if (sent) {
        await sb.from('payment_plan_installments').update({
          reminder_milestones_sent: [...sentMilestones, String(matched)],
        }).eq('id', inst.id);
        reminded++;
      }
    }

    // 4. Plans that ended before the season started lose the gate the day it
    //    starts, not the day the card bounced.
    let enforced = 0;
    const { data: pending } = await sb.from('payment_plans')
      .select('*').in('status', ['lapsed', 'cancelled']).is('enforced_at', null).limit(200);
    for (const plan of (pending ?? [])) {
      const club = await clubFor(plan.tenant_id as string);
      if (!club || !(await seasonStarted(sb, club, plan))) continue;
      await enforceEnd(sb, club, plan);
      enforced++;
    }

    // 4b. Parties approved but not paid within the club's hold (2 days) give
    //     their time back (PLAN.md O). A Venmo the family says they sent
    //     holds it until the board confirms. The family is told.
    let parties_released = 0;
    try {
      const { partySettings } = await import('../_shared/party_slots.ts');
      const { data: unpaid } = await sb.from('party_bookings')
        .select('id, tenant_id, household_id, requested_by, title, decided_at, starts_at')
        .eq('status', 'approved').eq('payment_status', 'unpaid').not('decided_at', 'is', null).limit(200);
      for (const p of unpaid ?? []) {
        const club = await clubFor(p.tenant_id as string);
        if (!club) continue;
        const hold = partySettings(club.sv).hold_days;
        if (Date.now() - Date.parse(p.decided_at as string) < hold * 86400_000) continue;
        await sb.from('party_bookings').update({
          status: 'cancelled', updated_at: new Date().toISOString(),
          admin_notes: `Released: not paid within ${hold} day${hold === 1 ? '' : 's'} of approval.`,
        }).eq('id', p.id).eq('status', 'approved').eq('payment_status', 'unpaid');
        await sb.from('admin_tasks').update({ completed_at: new Date().toISOString() })
          .eq('source_kind', 'party_booking').eq('source_id', p.id).is('completed_at', null);
        const { pushMembers } = await import('../_shared/member_notify.ts');
        await pushMembers({ tenant_id: p.tenant_id as string, household_ids: [p.household_id as string],
          title: `${p.title}: the time was released`, body: `It wasn't paid within ${hold} days. Book it again if it's still open.`, url: '/m/#parties', tag: `party-${p.id}` });
        try {
          const { data: who } = await sb.from('household_members').select('name, email').eq('id', p.requested_by).maybeSingle();
          if (who?.email) {
            const { sendEmail, emailShell, escHtml } = await import('../_shared/send_email.ts');
            await sendEmail({ to: who.email as string, subject: `${club.name}: your party time was released`,
              html: emailShell({ tenantName: club.name, clubUrl: club.clubUrl, preheader: 'It was not paid in time.',
                contentHtml: `<p style="margin:0 0 12px">Hi ${escHtml(String(who.name ?? ''))}, your party "${escHtml(String(p.title))}" wasn't paid within ${hold} days of being approved, so the time was released for other families.</p>
                  <p style="margin:0"><a href="${club.clubUrl}/m/#parties" style="display:inline-block;padding:10px 18px;background:#0a3b5c;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Book it again</a></p>` }) });
          }
        } catch { /* the pop-up and the Parties page say it too */ }
        parties_released++;
      }
    } catch (e) { console.error('party release (non-fatal):', (e as Error).message); }

    // 5. Referral rewards whose 30 days are up go to the board, and the
    //    member is texted (H6). Folded in here: one daily job, not two.
    let referralsUnlocked = 0;
    try {
      const { unlockDueRewards } = await import('../_shared/referral_rewards.ts');
      referralsUnlocked = await unlockDueRewards(sb);
    } catch (e) { console.error('referral unlock failed:', (e as Error).message); }

    // ── Free-season warnings ─────────────────────────────────────────
    // Folded into this daily run rather than given its own schedule: it is
    // one query a day, and another cron is another thing to forget exists.
    //
    // Nothing read trial_ends_at until 2026-09-08 — it was written at signup
    // and never acted on. Now that the household and SMS allowances really
    // do fall back when the free season ends, a club could otherwise arrive
    // one morning unable to approve a family, with nothing having told them
    // why. This does not block or downgrade anything; it just means the end
    // of the free season is never a surprise.
    let trial_notices = 0;
    try {
      const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
      const { data: trials } = await sb.from('tenants')
        .select('id, slug, display_name, trial_ends_at, trial_notice_stage')
        .eq('status', 'trial').not('trial_ends_at', 'is', null);

      for (const t of (trials ?? [])) {
        const daysLeft = Math.ceil(
          (new Date(t.trial_ends_at as string).getTime() - Date.now()) / 86400_000);
        // Furthest milestone reached, and only if we have not sent it yet.
        const stage = daysLeft <= 0 ? 'expired' : daysLeft <= 7 ? 't7' : daysLeft <= 30 ? 't30' : null;
        if (!stage) continue;
        const ORDER = { t30: 1, t7: 2, expired: 3 } as Record<string, number>;
        const sent = t.trial_notice_stage as string | null;
        if (sent && ORDER[sent] >= ORDER[stage]) continue;

        const { data: owners } = await sb.from('admin_users')
          .select('email').eq('tenant_id', t.id as string).eq('active', true)
          .eq('role_template', 'owner');
        const club = escHtml(String(t.display_name ?? 'your club'));
        const billing = `https://${t.slug}.poolsideapp.com/club/admin/billing.html`;
        const subject = stage === 'expired'
          ? `Your free season at ${t.display_name} has ended`
          : `${daysLeft} days left in your free season at ${t.display_name}`;
        const lead = stage === 'expired'
          ? `<p>Your free first season at <b>${club}</b> has ended. Nothing has been deleted and your members can still sign in — but your household and text allowances have dropped to the entry tier, so you may not be able to approve new families until you pick a plan.</p>`
          : `<p>Your free first season at <b>${club}</b> ends in <b>${daysLeft} days</b>. Nothing happens automatically and no card is on file — but after that your household and text allowances drop to the entry tier.</p>`;
        const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:560px;padding:24px;color:#0f172a">
            <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 12px">${escHtml(subject)}</h2>
            ${lead}
            <p style="margin:16px 0"><a href="${billing}" style="display:inline-block;padding:11px 20px;background:#0a3b5c;color:#fff;text-decoration:none;border-radius:10px;font-weight:600">Choose a plan</a></p>
            <p style="font-size:13px;color:#475569;margin:0">Not sure which one? Reply to this email and we'll work it out from your household count.</p>
          </div>`;
        let any = false;
        for (const o of (owners ?? [])) {
          if (!o.email) continue;
          try { const r = await sendEmail({ to: o.email as string, subject, html }); any = any || r.sent; }
          catch { /* one bad address must not stop the rest */ }
        }
        // Stamp regardless of delivery, so a permanently bouncing address
        // cannot make this club the only thing the cron ever does.
        await sb.from('tenants').update({ trial_notice_stage: stage }).eq('id', t.id as string);
        if (any) trial_notices++;
      }
    } catch (e) {
      console.error('trial notices (non-fatal):', (e as Error).message);
    }

    // ── Late fees ────────────────────────────────────────────────────
    // Assess, once, for households still unpaid past the club's own due date
    // plus its own grace period. Both numbers come from the club; Poolside
    // picks neither.
    //
    // The safety here is the unique index on (tenant, household, season), not
    // this loop: this job runs every morning, and without that index a family
    // that stayed unpaid through June would be charged thirty times. The
    // insert is expected to collide on most days and that collision IS the
    // idempotency. Do not "fix" it by pre-checking and inserting — two runs
    // overlapping would still double-charge.
    let late_fees_assessed = 0;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const { data: clubs } = await sb.from('tenants')
        .select('id, late_fee_cents, late_fee_grace_days, dues_due_date')
        .eq('late_fee_enabled', true)
        .not('dues_due_date', 'is', null);

      for (const c of (clubs ?? [])) {
        const due = String(c.dues_due_date);
        const grace = Number(c.late_fee_grace_days ?? 0);
        const amount = Number(c.late_fee_cents ?? 0);
        if (amount <= 0) continue;

        const cutoff = new Date(`${due}T00:00:00Z`);
        cutoff.setUTCDate(cutoff.getUTCDate() + grace);
        if (today < cutoff.toISOString().slice(0, 10)) continue;   // still in grace

        const seasonYear = Number(due.slice(0, 4));

        const { data: unpaid } = await sb.from('households')
          .select('id')
          .eq('tenant_id', c.id as string)
          .eq('active', true)
          .eq('dues_paid_for_year', false);
        if (!unpaid || !unpaid.length) continue;
        // A family paying on a plan isn't late; its own dates decide that.
        const { data: onPlan } = await sb.from('payment_plans').select('household_id')
          .eq('tenant_id', c.id as string).eq('status', 'active').not('household_id', 'is', null);
        const planned = new Set((onPlan ?? []).map(p => p.household_id as string));

        for (const h of unpaid) {
          if (planned.has(h.id as string)) continue;
          const { error } = await sb.from('late_fees').insert({
            tenant_id:    c.id,
            household_id: h.id,
            season_year:  seasonYear,
            amount_cents: amount,
            due_date:     due,
            grace_days:   grace,
            status:       'assessed',
          });
          // 23505 = already assessed this season. The expected case.
          if (!error) late_fees_assessed++;
          else if ((error as { code?: string }).code !== '23505') {
            console.error('late fee insert failed:', error.message);
          }
        }
      }
    } catch (e) {
      console.error('late fees (non-fatal):', (e as Error).message);
    }

    // ── Drain the email queue ────────────────────────────────────────
    // Bulk mail that did not fit in yesterday's Resend allowance. Runs last
    // so the transactional mail above has first claim on today's budget.
    let emails_sent = 0, emails_queued = 0;
    try {
      const { drainEmailQueue } = await import('../_shared/email_budget.ts');
      const r = await drainEmailQueue(sb);
      emails_sent = r.sent; emails_queued = r.still_queued;
    } catch (e) {
      console.error('email queue drain (non-fatal):', (e as Error).message);
    }

    return jsonResponse({ ok: true, charged, retried, lapsed, past_deadline, reminded, enforced, parties_released, trial_notices, late_fees_assessed, emails_sent, emails_queued, referrals_unlocked: referralsUnlocked });
  }

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';

  // ── A family's own plan (member token) ───────────────────────────────────
  //   { action: 'member_plan' }    → { ok, plan }   what's paid, balance, next, schedule
  //   { action: 'member_cancel' }  → { ok }         no refund; treated like a lapse
  if (action === 'member_plan' || action === 'member_cancel') {
    const m = tokRaw ? await verifyMember(tokRaw) : null;
    if (!m) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
    if (action === 'member_plan') {
      return jsonResponse({ ok: true, plan: await memberPlanView(sb, m.tid, m.hid) });
    }
    const { data: plan } = await sb.from('payment_plans').select('*')
      .eq('tenant_id', m.tid).eq('household_id', m.hid).eq('status', 'active')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!plan) return jsonResponse({ ok: false, error: 'No active payment plan.' }, 404);
    const club = await loadPlanClub(sb, m.tid);
    if (!club) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    await endPlan(sb, club, plan, 'member_cancelled');
    return jsonResponse({ ok: true, plan: await memberPlanView(sb, m.tid, m.hid) });
  }

  // ── Admin actions below — verify tenant admin ────────────────────────────
  const payload = tokRaw ? await verifyAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  if (!(await hasPaymentsScope(sb, payload))) return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);

  if (action === 'config_get') {
    const { data } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
    const tiers = ((data?.value as Record<string, unknown> | undefined)?.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
    return jsonResponse({
      ok: true, config: planConfig(data?.value),
      tiers_available: tiers.map(t => ({ slug: t.slug, label: t.label })),
    });
  }

  if (action === 'config_save') {
    const c = (body.config ?? {}) as Partial<PlanConfig>;
    const { data: existing } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
    const value = (existing?.value as Record<string, unknown> | undefined) || {};
    const payments = (value.payments as Record<string, unknown> | undefined) || {};
    // Saved over what the club already had, so a screen that does not know
    // a setting cannot wipe it.
    const merged = planConfig({ payments: { plan: { ...((payments.plan as Record<string, unknown>) ?? {}), ...c } } });
    const newValue = { ...value, payments: { ...payments, plan: merged } };
    if (existing) {
      const { error } = await sb.from('settings').update({ value: newValue }).eq('tenant_id', payload.tid);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    } else {
      const { error } = await sb.from('settings').insert({ tenant_id: payload.tid, value: newValue });
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }
    return jsonResponse({ ok: true, config: merged });
  }

  // The board's table: member, plan, paid, balance, next charge, status, fob.
  if (action === 'list_plans') {
    const club = await loadPlanClub(sb, payload.tid);
    if (!club) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const { data: plans } = await sb.from('payment_plans').select('*')
      .eq('tenant_id', payload.tid).order('created_at', { ascending: false }).limit(300);
    const ids = (plans ?? []).map(p => p.id);
    const byPlan = new Map<string, Inst[]>();
    if (ids.length) {
      const { data } = await sb.from('payment_plan_installments').select('*').in('plan_id', ids).order('sequence');
      for (const r of (data ?? []) as Inst[] & { plan_id: string }[]) {
        const k = (r as unknown as { plan_id: string }).plan_id;
        if (!byPlan.has(k)) byPlan.set(k, []);
        byPlan.get(k)!.push(r as Inst);
      }
    }
    const views = (plans ?? []).map(p => planView(club, p, byPlan.get(p.id as string) ?? []));
    return jsonResponse({ ok: true, plans: views, test_mode: club.testMode, today: club.today });
  }

  if (action === 'mark_paid') {
    const id = String(body.installment_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'installment_id required' }, 400);
    const { data: inst } = await sb.from('payment_plan_installments').select('*')
      .eq('id', id).eq('tenant_id', payload.tid).maybeSingle();
    if (!inst) return jsonResponse({ ok: false, error: 'Installment not found' }, 404);
    await sb.from('payment_plan_installments').update({
      status: 'manual', paid_at: new Date().toISOString(), last_error: null,
    }).eq('id', id);
    const club = await loadPlanClub(sb, payload.tid);
    const { data: plan } = await sb.from('payment_plans').select('*').eq('id', inst.plan_id).maybeSingle();
    if (club && plan) await afterPayment(sb, club, plan);
    return jsonResponse({ ok: true });
  }

  // Test payments only: move a plan along without waiting a month. Marks
  // the next payment paid exactly as a successful charge would, receipt and
  // all, so the board can watch the gate open at half paid.
  if (action === 'simulate_charge') {
    const club = await loadPlanClub(sb, payload.tid);
    if (!club?.testMode) return jsonResponse({ ok: false, error: 'Only while test payments are on.' }, 403);
    const { data: plan } = await sb.from('payment_plans').select('*')
      .eq('id', String(body.plan_id ?? '')).eq('tenant_id', payload.tid).maybeSingle();
    if (!plan || plan.status !== 'active') return jsonResponse({ ok: false, error: 'No active plan.' }, 404);
    const rows = await installmentsOf(sb, plan.id as string);
    const next = rows.find(r => !isPaid(r));
    if (!next) return jsonResponse({ ok: false, error: 'Already paid in full.' }, 409);
    const now = new Date().toISOString();
    await sb.from('payment_plan_installments').update({
      status: 'paid', paid_at: now, stripe_payment_intent_id: `sim_pi_${crypto.randomUUID().slice(0, 8)}`, last_error: null,
    }).eq('id', next.id);
    next.status = 'paid';
    await sendReceipt(sb, club, plan, next, rows, chargeFor(next, club.feesWaived));
    await afterPayment(sb, club, plan);
    return jsonResponse({ ok: true });
  }

  if (action === 'reactivate') {
    const planId = String(body.plan_id ?? '');
    if (!planId) return jsonResponse({ ok: false, error: 'plan_id required' }, 400);
    if (!STRIPE_KEY) return jsonResponse({ ok: false, error: 'STRIPE_SECRET_KEY not set' }, 503);
    const { data: plan } = await sb.from('payment_plans').select('*').eq('id', planId).eq('tenant_id', payload.tid).maybeSingle();
    if (!plan) return jsonResponse({ ok: false, error: 'Plan not found' }, 404);
    if (plan.status !== 'lapsed' && plan.status !== 'cancelled') return jsonResponse({ ok: false, error: 'Plan is not lapsed' }, 409);

    const { data: tenant } = await sb.from('tenants').select('slug, stripe_account_id, stripe_charges_enabled, display_name, platform_fees_waived')
      .eq('id', payload.tid).maybeSingle();
    if (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled) {
      return jsonResponse({ ok: false, error: 'Stripe not ready for this tenant' }, 503);
    }
    const { data: settingsRow } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
    const config = planConfig(settingsRow?.value);

    // Sum unpaid installments + reactivation fee
    const { data: outstanding } = await sb.from('payment_plan_installments').select('amount_cents, plan_fee_cents, id, sequence')
      .eq('plan_id', planId).neq('status', 'paid').neq('status', 'manual').order('sequence');
    const balance = (outstanding ?? []).reduce((s, i) => s + (i.amount_cents as number), 0);
    // Plan fees for the installments being caught up. Skipping them would
    // hand a lapsed member the plan for free — precisely the family whose
    // payments already needed chasing.
    const reactivationPolicy = feePolicyFromTenant(tenant);
    // Stored plan fees are dropped entirely under a waiver, so they come out
    // of the member's total as well as out of our cut.
    const planFees = reactivationPolicy.waived
      ? 0
      : (outstanding ?? []).reduce((s, i) => s + Number(i.plan_fee_cents ?? 0), 0);
    const total = balance + planFees + config.reactivation_fee_cents;
    if (total <= 0) return jsonResponse({ ok: false, error: 'Nothing owed' }, 400);

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const params: Record<string, string | number> = {
      mode: 'payment',
      success_url: `${clubUrl}/club/admin/payments.html?reactivated=1`,
      cancel_url:  `${clubUrl}/club/admin/payments.html?reactivated=0`,
      'line_items[0][price_data][currency]': 'usd',
      'line_items[0][price_data][product_data][name]': `${tenant.display_name} dues — reactivation`,
      'line_items[0][price_data][unit_amount]': String(total),
      'line_items[0][quantity]': '1',
      'metadata[kind]': 'payment_plan_reactivation',
      'metadata[plan_id]': planId,
      'metadata[tenant_id]': payload.tid,
      'metadata[fee_plan_cents]': String(planFees),
      'metadata[fee_dues_cents]': String(reactivationPolicy.waived
        ? 0
        : platformFeeCents(balance, 'dues', reactivationPolicy)),
      // Our cut on the dues portion only, plus the plan fees in full.
      application_fee_amount: String(reactivationPolicy.waived
        ? 0
        : platformFeeCents(balance, 'dues', reactivationPolicy) + planFees),
    };
    if (plan.primary_email) params.customer_email = plan.primary_email as string;
    const r = await stripe<{ url: string }>('/checkout/sessions', params, tenant.stripe_account_id);
    if (!r.ok) return jsonResponse({ ok: false, error: r.error }, 500);
    return jsonResponse({ ok: true, url: r.data!.url, total_cents: total });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

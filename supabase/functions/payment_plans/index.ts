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
//   { action: 'mark_paid', installment_id, note? } → { ok }   manual override (e.g. cash/check)
//   { action: 'cron_run' }                    → { ok, charged, reminded, lapsed }
// =============================================================================

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
function hasPaymentsScope(p: AdminPayload): boolean {
  if (p.is_super) return true;
  if (p.role_template === 'owner') return true;
  return Array.isArray(p.scopes) && p.scopes.includes('payments');
}

const DEFAULT_PLAN_CONFIG = {
  enabled: false,
  season_open_date: null as string | null,           // 'YYYY-MM-DD'
  final_due_date: null as string | null,
  first_installment_pct: 50,                          // 0-100
  plan_signup_cutoff_date: null as string | null,    // last day a member can sign up for installments
  reminder_days_before: [14, 7, 1] as number[],      // ping member at these milestones
  lapse_grace_days: 14,                               // days from first failure before lapse
  reactivation_fee_cents: 5000,                       // $50 default
  auto_deactivate_keyfob: true,                       // flip can_unlock_gate=false on lapse
};
type PlanConfig = typeof DEFAULT_PLAN_CONFIG;

async function getPlanConfig(sb: SupabaseClient, tenantId: string): Promise<PlanConfig> {
  const { data } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const raw = ((data?.value as Record<string, unknown> | undefined)?.payments as Record<string, unknown> | undefined)?.plan as Partial<PlanConfig> | undefined;
  return { ...DEFAULT_PLAN_CONFIG, ...(raw || {}) };
}

// Stripe API helper — direct charges on Connect Standard, Stripe-Account header
// scopes operations to the tenant's connected account.
async function stripe<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string | number>,
  stripeAccount: string,
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
      <p style="margin:0 0 16px;color:#64748b">Hi ${escHtml(args.familyName)} family — your next ${escHtml(args.tenantName)} dues installment of <b>$${dollars}</b> will be auto-charged on <b>${escHtml(args.dueDate)}</b> to the card you saved at sign-up.</p>
      <p style="margin:24px 0">
        <a href="${args.signinLink}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to ${escHtml(args.tenantName)}</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">If you need to update your card, sign in and contact the board.</p>
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

async function sendLapseAdminAlert(sb: SupabaseClient, tenantId: string, plan: Record<string, unknown>): Promise<void> {
  // 1. Open admin task
  await sb.from('admin_tasks').insert({
    tenant_id: tenantId,
    target_scopes: ['payments', 'membership'],
    kind: 'plan.lapsed',
    summary: `${plan.family_name}: payment plan lapsed — contact household and reactivate`,
    link_url: '/club/admin/payments.html',
    source_kind: 'payment_plan', source_id: plan.id as string,
  });
  // 2. Email admin owners (best-effort)
  if (!RESEND_API_KEY) return;
  const { data: owners } = await sb.from('admin_users')
    .select('email, display_name')
    .eq('tenant_id', tenantId).eq('active', true)
    .or('role_template.eq.owner,role_template.eq.treasurer,role_template.eq.membership');
  const { data: tenant } = await sb.from('tenants').select('display_name, slug').eq('id', tenantId).maybeSingle();
  if (!tenant || !owners?.length) return;
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px">
      <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 8px">⚠ Payment plan lapsed</h2>
      <p>The ${escHtml(plan.family_name as string)} family's payment plan has lapsed after exhausting card retries. Their keyfobs have been auto-deactivated.</p>
      <p style="margin:24px 0"><a href="https://${tenant.slug}.poolsideapp.com/club/admin/payments.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Review &amp; reactivate →</a></p>
    </div>`;
  for (const o of owners) {
    if (!o.email) continue;
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: RESEND_FROM, to: [o.email], subject: `[Action needed] ${plan.family_name} plan lapsed`, html }),
      });
    } catch { /* best-effort */ }
  }
}

// Charge a single installment via off-session PaymentIntent on the connected account.
async function chargeInstallment(
  sb: SupabaseClient,
  installment: Record<string, unknown>,
  plan: Record<string, unknown>,
  stripeAccount: string,
  config: PlanConfig,
): Promise<{ paid: boolean; lapsed: boolean; error?: string }> {
  const installmentId = installment.id as string;
  const idempotencyKey = `installment_${installmentId}_attempt_${(installment.attempt_count as number ?? 0) + 1}`;
  const params: Record<string, string | number> = {
    amount: installment.amount_cents as number,
    currency: 'usd',
    customer: plan.stripe_customer_id as string,
    payment_method: plan.stripe_payment_method_id as string,
    confirm: 'true',
    off_session: 'true',
    'metadata[plan_id]': plan.id as string,
    'metadata[installment_id]': installmentId,
    'metadata[tenant_id]': plan.tenant_id as string,
    'metadata[kind]': 'payment_plan_installment',
    application_fee_amount: Math.round((installment.amount_cents as number) * 0.005),  // 0.5% on dues per fee memory
  };
  // Idempotency-Key prevents double-charge if cron retries within Stripe's 24h dedup window
  if (!STRIPE_KEY) return { paid: false, lapsed: false, error: 'STRIPE_SECRET_KEY not set' };
  let res: Response;
  try {
    res = await fetch(`https://api.stripe.com/v1/payment_intents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Account': stripeAccount,
        'Idempotency-Key': idempotencyKey,
      },
      body: new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString(),
    });
  } catch (e) {
    return { paid: false, lapsed: false, error: String(e) };
  }
  const data = await res.json();
  const attempts = (installment.attempt_count as number ?? 0) + 1;
  if (res.ok && data.status === 'succeeded') {
    await sb.from('payment_plan_installments').update({
      status: 'paid', paid_at: new Date().toISOString(),
      stripe_payment_intent_id: data.id,
      attempt_count: attempts, last_attempt_at: new Date().toISOString(),
      last_error: null,
    }).eq('id', installmentId);
    return { paid: true, lapsed: false };
  }
  // Failed. Retry schedule: day 1, 3, 7 from first attempt; lapse at attempt > 4 OR past grace days.
  const errorMsg = (data?.error?.message || `Stripe ${res.status}`).slice(0, 500);
  const firstAttempt = (installment.last_attempt_at as string | null) || new Date().toISOString();
  const daysSinceFirst = Math.floor((Date.now() - new Date(firstAttempt).getTime()) / 86400_000);
  const exhausted = attempts >= 4 || daysSinceFirst >= config.lapse_grace_days;
  await sb.from('payment_plan_installments').update({
    status: exhausted ? 'failed' : 'retrying',
    attempt_count: attempts,
    last_attempt_at: new Date().toISOString(),
    last_error: errorMsg,
  }).eq('id', installmentId);
  return { paid: false, lapsed: exhausted, error: errorMsg };
}

// Mark plan lapsed: deactivate keyfob, household dues unpaid, admin task + email.
async function lapsePlan(sb: SupabaseClient, plan: Record<string, unknown>, config: PlanConfig): Promise<void> {
  const planId = plan.id as string;
  const tenantId = plan.tenant_id as string;
  await sb.from('payment_plans').update({
    status: 'lapsed', lapsed_at: new Date().toISOString(),
  }).eq('id', planId);
  if (plan.household_id) {
    await sb.from('households').update({ dues_paid_for_year: false }).eq('id', plan.household_id);
    if (config.auto_deactivate_keyfob) {
      // Adult + teen members lose gate access. Children unaffected (they don't have keyfobs).
      await sb.from('household_members').update({ can_unlock_gate: false })
        .eq('household_id', plan.household_id).eq('tenant_id', tenantId)
        .in('role', ['primary', 'adult', 'teen']);
    }
  }
  await sendLapseAdminAlert(sb, tenantId, plan);
  await sb.from('audit_log').insert({
    tenant_id: tenantId,
    kind: 'plan.lapsed',
    entity_type: 'payment_plan', entity_id: planId,
    summary: `Payment plan lapsed for ${plan.family_name}`,
    actor_kind: 'system', actor_label: 'cron',
    metadata: { reactivation_fee_cents: config.reactivation_fee_cents },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Cron runner — gated by CRON_SECRET, no admin auth. Drains charges + reminders.
  if (action === 'cron_run') {
    const got = req.headers.get('x-cron-secret') || '';
    if (!CRON_SECRET || got !== CRON_SECRET) {
      return jsonResponse({ ok: false, error: 'Bad cron secret' }, 401);
    }
    const today = new Date().toISOString().slice(0, 10);

    // 1. Charge installments due today (or earlier if pending/retrying)
    const { data: dueInstallments } = await sb.from('payment_plan_installments')
      .select('*').lte('due_date', today).in('status', ['pending', 'retrying']).limit(200);
    let charged = 0, lapsed = 0;
    for (const inst of (dueInstallments ?? [])) {
      const { data: plan } = await sb.from('payment_plans').select('*').eq('id', inst.plan_id).maybeSingle();
      if (!plan || plan.status !== 'active') continue;
      if (!plan.stripe_customer_id || !plan.stripe_payment_method_id) continue;
      const { data: tenant } = await sb.from('tenants').select('stripe_account_id, stripe_charges_enabled')
        .eq('id', plan.tenant_id).maybeSingle();
      if (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled) continue;
      const config = await getPlanConfig(sb, plan.tenant_id);
      const result = await chargeInstallment(sb, inst, plan, tenant.stripe_account_id, config);
      if (result.paid) {
        charged++;
        // If all installments paid, complete the plan.
        const { data: remaining } = await sb.from('payment_plan_installments').select('id', { count: 'exact', head: true })
          .eq('plan_id', plan.id).neq('status', 'paid');
        if ((remaining as unknown as { count?: number })?.count === 0) {
          await sb.from('payment_plans').update({
            status: 'completed', completed_at: new Date().toISOString(),
          }).eq('id', plan.id);
          if (plan.household_id) {
            await sb.from('households').update({
              dues_paid_for_year: true, paid_until_year: new Date().getFullYear(),
            }).eq('id', plan.household_id);
          }
        }
      }
      if (result.lapsed) {
        lapsed++;
        await lapsePlan(sb, plan, config);
      }
    }

    // 2. Send reminders for upcoming installments (14, 7, 1 days out — config-driven)
    let reminded = 0;
    const { data: planConfigs } = await sb.from('settings').select('tenant_id, value');
    const tenantToConfig = new Map<string, PlanConfig>();
    for (const row of (planConfigs ?? [])) {
      const raw = ((row.value as Record<string, unknown>)?.payments as Record<string, unknown> | undefined)?.plan as Partial<PlanConfig> | undefined;
      tenantToConfig.set(row.tenant_id as string, { ...DEFAULT_PLAN_CONFIG, ...(raw || {}) });
    }
    const todayMs = new Date(today + 'T00:00:00Z').getTime();
    const { data: upcoming } = await sb.from('payment_plan_installments')
      .select('*').gt('due_date', today).eq('status', 'pending').limit(500);
    for (const inst of (upcoming ?? [])) {
      const config = tenantToConfig.get(inst.tenant_id) ?? DEFAULT_PLAN_CONFIG;
      const dueMs = new Date((inst.due_date as string) + 'T00:00:00Z').getTime();
      const daysUntil = Math.round((dueMs - todayMs) / 86400_000);
      const matchedMilestone = config.reminder_days_before.find(d => d === daysUntil);
      if (matchedMilestone === undefined) continue;
      const sentMilestones = (inst.reminder_milestones_sent as string[]) ?? [];
      if (sentMilestones.includes(String(matchedMilestone))) continue;

      const { data: plan } = await sb.from('payment_plans').select('*').eq('id', inst.plan_id).maybeSingle();
      if (!plan || plan.status !== 'active' || !plan.primary_email) continue;
      const { data: tenant } = await sb.from('tenants').select('display_name, slug').eq('id', plan.tenant_id).maybeSingle();
      if (!tenant) continue;
      const sent = await sendReminderEmail({
        to: plan.primary_email,
        tenantName: tenant.display_name as string,
        familyName: plan.family_name as string,
        amountCents: inst.amount_cents,
        dueDate: inst.due_date as string,
        daysUntil,
        signinLink: `https://${tenant.slug}.poolsideapp.com/m/login.html`,
      });
      if (sent) {
        await sb.from('payment_plan_installments').update({
          reminder_milestones_sent: [...sentMilestones, String(matchedMilestone)],
        }).eq('id', inst.id);
        reminded++;
      }
    }

    return jsonResponse({ ok: true, charged, lapsed, reminded });
  }

  // ── Admin actions below — verify tenant admin ────────────────────────────
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  if (!hasPaymentsScope(payload)) return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);

  if (action === 'config_get') {
    const config = await getPlanConfig(sb, payload.tid);
    return jsonResponse({ ok: true, config });
  }

  if (action === 'config_save') {
    const c = (body.config ?? {}) as Partial<PlanConfig>;
    const merged: PlanConfig = { ...DEFAULT_PLAN_CONFIG, ...c };
    const { data: existing } = await sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle();
    const value = (existing?.value as Record<string, unknown> | undefined) || {};
    const payments = (value.payments as Record<string, unknown> | undefined) || {};
    const newValue = { ...value, payments: { ...payments, plan: merged } };
    if (existing) {
      const { error } = await sb.from('settings').update({ value: newValue }).eq('tenant_id', payload.tid);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    } else {
      const { error } = await sb.from('settings').insert({ tenant_id: payload.tid, value: newValue });
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }
    return jsonResponse({ ok: true });
  }

  if (action === 'list_plans') {
    const filter = String(body.filter ?? 'all');  // 'active' | 'lapsed' | 'completed' | 'all'
    let q = sb.from('payment_plans').select('*').eq('tenant_id', payload.tid).order('created_at', { ascending: false }).limit(200);
    if (filter !== 'all') q = q.eq('status', filter);
    const { data: plans } = await q;
    const planIds = (plans ?? []).map(p => p.id);
    let installments: Record<string, unknown>[] = [];
    if (planIds.length) {
      const { data } = await sb.from('payment_plan_installments').select('*')
        .in('plan_id', planIds).order('sequence');
      installments = data ?? [];
    }
    return jsonResponse({ ok: true, plans: plans ?? [], installments });
  }

  if (action === 'mark_paid') {
    const id = String(body.installment_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'installment_id required' }, 400);
    const { data: inst } = await sb.from('payment_plan_installments').select('*')
      .eq('id', id).eq('tenant_id', payload.tid).maybeSingle();
    if (!inst) return jsonResponse({ ok: false, error: 'Installment not found' }, 404);
    await sb.from('payment_plan_installments').update({
      status: 'manual', paid_at: new Date().toISOString(),
      last_error: null,
    }).eq('id', id);
    // If all installments now done, complete the plan.
    const { data: rem } = await sb.from('payment_plan_installments').select('id', { count: 'exact', head: true })
      .eq('plan_id', inst.plan_id).neq('status', 'paid').neq('status', 'manual');
    if ((rem as unknown as { count?: number })?.count === 0) {
      const { data: plan } = await sb.from('payment_plans').select('household_id').eq('id', inst.plan_id).maybeSingle();
      await sb.from('payment_plans').update({
        status: 'completed', completed_at: new Date().toISOString(),
      }).eq('id', inst.plan_id);
      if (plan?.household_id) {
        await sb.from('households').update({
          dues_paid_for_year: true, paid_until_year: new Date().getFullYear(),
        }).eq('id', plan.household_id);
      }
    }
    return jsonResponse({ ok: true });
  }

  if (action === 'reactivate') {
    const planId = String(body.plan_id ?? '');
    if (!planId) return jsonResponse({ ok: false, error: 'plan_id required' }, 400);
    if (!STRIPE_KEY) return jsonResponse({ ok: false, error: 'STRIPE_SECRET_KEY not set' }, 503);
    const { data: plan } = await sb.from('payment_plans').select('*').eq('id', planId).eq('tenant_id', payload.tid).maybeSingle();
    if (!plan) return jsonResponse({ ok: false, error: 'Plan not found' }, 404);
    if (plan.status !== 'lapsed') return jsonResponse({ ok: false, error: 'Plan is not lapsed' }, 409);

    const { data: tenant } = await sb.from('tenants').select('slug, stripe_account_id, stripe_charges_enabled, display_name')
      .eq('id', payload.tid).maybeSingle();
    if (!tenant?.stripe_account_id || !tenant.stripe_charges_enabled) {
      return jsonResponse({ ok: false, error: 'Stripe not ready for this tenant' }, 503);
    }
    const config = await getPlanConfig(sb, payload.tid);

    // Sum unpaid installments + reactivation fee
    const { data: outstanding } = await sb.from('payment_plan_installments').select('amount_cents, id, sequence')
      .eq('plan_id', planId).neq('status', 'paid').neq('status', 'manual').order('sequence');
    const balance = (outstanding ?? []).reduce((s, i) => s + (i.amount_cents as number), 0);
    const total = balance + config.reactivation_fee_cents;
    if (total <= 0) return jsonResponse({ ok: false, error: 'Nothing owed' }, 400);

    const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
    const params: Record<string, string> = {
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
      application_fee_amount: String(Math.round(total * 0.005)),
    };
    if (plan.primary_email) params.customer_email = plan.primary_email as string;
    const r = await stripe<{ url: string }>('/checkout/sessions', params, tenant.stripe_account_id);
    if (!r.ok) return jsonResponse({ ok: false, error: r.error }, 500);
    return jsonResponse({ ok: true, url: r.data!.url, total_cents: total });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

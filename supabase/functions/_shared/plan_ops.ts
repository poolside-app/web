// =============================================================================
// plan_ops.ts — what happens to a payment-plan family, in one place (PLAN.md M)
// =============================================================================
// Several functions move a plan along: stripe_checkout starts it, the webhook
// records payments made on Stripe's page, the daily payment_plans run charges
// the monthly ones, and members and the board act on it from their screens.
// Each of those has to agree on when a family gets the gate and their fob,
// what a lapse does and how a family comes back, so those rules live here.
//
// Doug, 2026-10-07:
// - The gate and fob start once half is paid (the club can choose card saved
//   or first payment instead).
// - A card that keeps failing, or a plan not paid in full by the club's
//   paid-in-full date, ends the plan: the family is told their membership is
//   canceled and how to pay the reactivation fee to come back, the Treasurer
//   gets one email, and the gate and fob go off (from the season's start).
// - A family that cancels gets no refund and is treated the same way.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { resolveRules, type ScheduleRules } from './payment_schedule.ts';
import { accessReady, type AccessRule } from './flex_plan.ts';
import { opensMonthOf } from './membership_year.ts';
import { poolToday, zoneOrDefault } from './pool_time.ts';

/** A club's plan settings with nothing missing. Saved at
 *  settings.value.payments.plan. */
export const PLAN_DEFAULTS = {
  enabled: false,
  milestones: [] as Array<{ date: string; min_pct: number; label?: string }>,
  min_installment_cents: 2500,
  max_installments: 12,
  plan_signup_cutoff_date: null as string | null,
  /** Doug's spec (10/7): members get receipts and failure emails, nothing
   *  else. Days before a charge to remind them, if a club wants it back. */
  reminder_days_before: [] as number[],
  /** Card retries: days after the first failure. The fourth failure ends it. */
  retry_days: [3, 7, 14] as number[],
  lapse_grace_days: 14,
  reactivation_fee_cents: 5000,
  auto_deactivate_keyfob: true,
  access_when: 'half_paid' as AccessRule,
  /** Membership types that may use a plan. Empty means all of them. */
  tiers: [] as string[],
  /** Kept for clubs set up before milestones. */
  season_open_date: null as string | null,
  final_due_date: null as string | null,
  first_installment_pct: 50,
};
export type PlanConfig = typeof PLAN_DEFAULTS;

export function planConfig(sv: unknown): PlanConfig {
  const raw = ((sv as Record<string, unknown> | null)?.payments as Record<string, unknown> | undefined)?.plan as Partial<PlanConfig> | undefined;
  const c = { ...PLAN_DEFAULTS, ...(raw ?? {}) } as PlanConfig;
  if (!['card', 'first_payment', 'half_paid'].includes(c.access_when)) c.access_when = 'half_paid';
  if (!Array.isArray(c.tiers)) c.tiers = [];
  if (!Array.isArray(c.retry_days) || !c.retry_days.length) c.retry_days = PLAN_DEFAULTS.retry_days;
  return c;
}

export type PlanClub = {
  tenantId: string; slug: string; name: string; tz: string; today: string;
  sv: Record<string, unknown>; cfg: PlanConfig; opensMonth: number;
  passFee: boolean; pct: number; fixed: number;
  stripeAccount: string | null; chargesEnabled: boolean; feesWaived: boolean; testMode: boolean;
  clubUrl: string;
};

export async function loadPlanClub(sb: SupabaseClient, tenantId: string): Promise<PlanClub | null> {
  const [{ data: t }, { data: s }] = await Promise.all([
    sb.from('tenants').select('id, slug, display_name, timezone, stripe_account_id, stripe_charges_enabled, platform_fees_waived')
      .eq('id', tenantId).maybeSingle(),
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  if (!t) return null;
  const sv = (s?.value ?? {}) as Record<string, unknown>;
  const pay = (sv.payments as Record<string, unknown> | undefined) ?? {};
  const tz = zoneOrDefault(t.timezone);
  return {
    tenantId, slug: t.slug as string, name: (t.display_name as string) || 'Your club', tz, today: poolToday(tz),
    sv, cfg: planConfig(sv), opensMonth: opensMonthOf(sv),
    passFee: !!pay.pass_stripe_fee, pct: Number(pay.stripe_pct ?? 2.9) / 100, fixed: Number(pay.stripe_fixed_cents ?? 30),
    stripeAccount: (t.stripe_account_id as string | null) ?? null,
    chargesEnabled: !!t.stripe_charges_enabled,
    feesWaived: !!t.platform_fees_waived,
    testMode: pay.test_mode === true,
    clubUrl: `https://${t.slug}.poolsideapp.com`,
  };
}

export function rulesFor(club: PlanClub, year: number): ScheduleRules {
  return resolveRules(club.cfg as unknown as Record<string, unknown>, year, club.opensMonth);
}

/** Whether a membership type may use a plan. */
export function tierAllowed(cfg: PlanConfig, tierSlug: string | null | undefined): boolean {
  return !cfg.tiers.length || (!!tierSlug && cfg.tiers.includes(tierSlug));
}

/** The season the plan pays for: its application's, else this year. */
export async function planYear(sb: SupabaseClient, plan: { application_id?: string | null }): Promise<number> {
  if (plan?.application_id) {
    const { data } = await sb.from('applications').select('membership_year').eq('id', plan.application_id).maybeSingle();
    const y = data?.membership_year as number | null | undefined;
    if (typeof y === 'number' && y > 2000) return y;
  }
  return new Date().getUTCFullYear();
}

export type Inst = {
  id: string; sequence: number; due_date: string; amount_cents: number;
  plan_fee_cents: number; card_fee_cents: number; status: string;
  attempt_count?: number | null; last_error?: string | null; paid_at?: string | null;
  first_failed_at?: string | null;
};
export const isPaid = (i: { status: string }) => i.status === 'paid' || i.status === 'manual';

export async function installmentsOf(sb: SupabaseClient, planId: string): Promise<Inst[]> {
  const { data } = await sb.from('payment_plan_installments').select('*').eq('plan_id', planId).order('sequence');
  return (data ?? []) as Inst[];
}

/** Dues paid so far (fees excluded). */
export function paidCents(rows: Inst[]): number {
  return rows.filter(isPaid).reduce((n, r) => n + r.amount_cents, 0);
}

/** What one installment charges the card: dues, plus its plan fee unless the
 *  club's fees are waived, plus its card fee. */
export function chargeFor(i: Inst, feesWaived: boolean): number {
  return i.amount_cents + (feesWaived ? 0 : Number(i.plan_fee_cents ?? 0)) + Number(i.card_fee_cents ?? 0);
}

const FOB_ROLES = ['primary', 'adult', 'teen'];

/**
 * Give the family the gate (and tell the Facilities Director the fobs can go
 * on) once the club's rule is met. Does nothing if they already have it.
 * `announce` is false when the family is being approved at the same moment,
 * since approval already puts them in front of the board.
 */
export async function grantAccessIfReady(
  sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>,
  opts: { announce: boolean; rows?: Inst[] },
): Promise<boolean> {
  if (plan.access_at || !plan.household_id) return false;
  const rows = opts.rows ?? await installmentsOf(sb, plan.id as string);
  const paid = paidCents(rows);
  if (!accessReady(club.cfg.access_when, {
    paidCents: paid, totalCents: Number(plan.total_cents), cardSaved: !!plan.stripe_payment_method_id,
  })) return false;

  const now = new Date().toISOString();
  const year = await planYear(sb, plan as { application_id?: string | null });
  const { data: hh } = await sb.from('households').select('paid_until_year').eq('id', plan.household_id).maybeSingle();
  await sb.from('households').update({
    dues_paid_for_year: true,
    paid_until_year: Math.max(Number(hh?.paid_until_year ?? 0), year),
  }).eq('id', plan.household_id);
  if (plan.enforced_at) {
    await sb.from('household_members').update({ can_unlock_gate: true })
      .eq('household_id', plan.household_id).eq('tenant_id', club.tenantId).in('role', FOB_ROLES);
  }
  await sb.from('payment_plans').update({ access_at: now, enforced_at: null }).eq('id', plan.id);
  plan.access_at = now;

  if (opts.announce || plan.enforced_at) {
    const why = club.cfg.access_when === 'card' ? 'saved a card for their payment plan'
      : club.cfg.access_when === 'first_payment' ? 'made the first payment on their plan'
      : 'paid half their dues';
    const { enqueueAdminTask } = await import('./enqueue_task.ts');
    await enqueueAdminTask(sb, {
      tenant_id: club.tenantId, target_scopes: ['households'], kind: 'plan.fob_on',
      summary: plan.enforced_at
        ? `${plan.family_name} are paid up again: turn their key fobs back on`
        : `${plan.family_name} have ${why}: their key fobs can be turned on`,
      link_url: '/club/admin/payments.html#plans',
      source_kind: 'payment_plan', source_id: plan.id as string,
    });
  }
  return true;
}

/** Mark the plan finished once every payment is in. */
export async function completeIfPaid(sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>, rows?: Inst[]): Promise<boolean> {
  const all = rows ?? await installmentsOf(sb, plan.id as string);
  if (!all.length || !all.every(isPaid)) return false;
  await sb.from('payment_plans').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', plan.id);
  plan.status = 'completed';
  // Fully paid meets every access rule.
  await grantAccessIfReady(sb, club, plan, { announce: true, rows: all });
  if (plan.household_id) {
    const year = await planYear(sb, plan as { application_id?: string | null });
    const { data: hh } = await sb.from('households').select('paid_until_year').eq('id', plan.household_id).maybeSingle();
    await sb.from('households').update({
      dues_paid_for_year: true, paid_until_year: Math.max(Number(hh?.paid_until_year ?? 0), year),
    }).eq('id', plan.household_id);
  }
  if (plan.application_id) {
    const now = new Date().toISOString();
    await sb.from('applications').update({ payment_status: 'paid', paid_at: now, verified_at: now })
      .eq('id', plan.application_id).neq('payment_status', 'paid');
  }
  return true;
}

/** True once the season has started, so switching the gate off means
 *  something: the club's season start date, else its first in-season deadline. */
export async function seasonStarted(sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>): Promise<boolean> {
  const year = await planYear(sb, plan as { application_id?: string | null });
  const start = ((club.sv.season as Record<string, unknown> | undefined)?.start_date as string | undefined) ?? null;
  if (start && start.startsWith(String(year))) return club.today >= start;
  const { seasonUnderway } = await import('./payment_schedule.ts');
  return seasonUnderway(club.cfg as unknown as Record<string, unknown>, year, club.today, club.opensMonth);
}

/** Take the gate away and tell the Facilities Director to turn the fobs off. */
export async function enforceEnd(sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>): Promise<void> {
  if (plan.enforced_at) return;
  const now = new Date().toISOString();
  if (plan.household_id) {
    await sb.from('households').update({ dues_paid_for_year: false }).eq('id', plan.household_id);
    if (club.cfg.auto_deactivate_keyfob) {
      await sb.from('household_members').update({ can_unlock_gate: false })
        .eq('household_id', plan.household_id).eq('tenant_id', club.tenantId).in('role', FOB_ROLES);
    }
  }
  await sb.from('payment_plans').update({ enforced_at: now, access_at: null }).eq('id', plan.id);
  plan.enforced_at = now; plan.access_at = null;
  if (plan.household_id) {
    const { enqueueAdminTask } = await import('./enqueue_task.ts');
    await enqueueAdminTask(sb, {
      tenant_id: club.tenantId, target_scopes: ['households'], kind: 'plan.fob_off',
      summary: `Turn off the ${plan.family_name} key fobs: their membership was canceled for unpaid dues`,
      link_url: '/club/admin/payments.html#plans',
      source_kind: 'payment_plan', source_id: plan.id as string,
    });
  }
}

export type EndReason = 'card_failed' | 'deadline' | 'member_cancelled';

/**
 * End a plan: a card that kept failing, not paid in full by the deadline, or
 * the family canceled. Nothing is refunded. The family is emailed that their
 * membership is canceled and how to come back; the Treasurer gets one email
 * (not for a cancellation, which they chose); the board gets a task; and the
 * gate and fobs go off once the season has started.
 */
export async function endPlan(sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>, reason: EndReason): Promise<void> {
  if (plan.status !== 'active') return;
  const now = new Date().toISOString();
  const status = reason === 'member_cancelled' ? 'cancelled' : 'lapsed';
  await sb.from('payment_plans').update({
    status, ended_reason: reason,
    ...(status === 'cancelled' ? { cancelled_at: now } : { lapsed_at: now }),
  }).eq('id', plan.id);
  plan.status = status; plan.ended_reason = reason;

  if (reason === 'deadline' || await seasonStarted(sb, club, plan)) await enforceEnd(sb, club, plan);

  const rows = await installmentsOf(sb, plan.id as string);
  const back = reinstateAmount(club, plan, rows);
  const why = reason === 'card_failed' ? 'your card could not be charged'
    : reason === 'deadline' ? `your dues weren't paid in full by the club's deadline`
    : 'you canceled your payment plan';

  if (plan.primary_email) {
    try {
      const { renderAndSend } = await import('./email_template.ts');
      await renderAndSend(sb, {
        tenantId: club.tenantId, templateKey: 'plan_cancelled', to: plan.primary_email as string,
        variables: {
          tenant_name: club.name, family_name: plan.family_name as string, reason: why,
          paid: money(paidCents(rows)), owed: money(back.dues_cents), fee: money(back.fee_cents),
          total: money(back.total_cents), club_url: club.clubUrl,
          manage_url: `${club.clubUrl}/m/#plan`,
        },
      });
    } catch (e) { console.error('plan_cancelled email:', (e as Error).message); }
  }

  const { enqueueAdminTask } = await import('./enqueue_task.ts');
  await enqueueAdminTask(sb, {
    tenant_id: club.tenantId, target_scopes: ['payments', 'households'],
    kind: reason === 'member_cancelled' ? 'plan.cancelled' : 'plan.lapsed',
    summary: reason === 'member_cancelled'
      ? `${plan.family_name} canceled their payment plan (${money(paidCents(rows))} paid, no refund)`
      : `${plan.family_name}: membership canceled, ${reason === 'deadline' ? 'not paid in full by the deadline' : 'card kept failing'}`,
    link_url: '/club/admin/payments.html#plans',
    source_kind: 'payment_plan', source_id: plan.id as string,
    push_title: reason === 'member_cancelled' ? `Plan canceled: ${plan.family_name}` : `Plan lapsed: ${plan.family_name}`,
    push_body: 'Their membership is canceled until they pay what is overdue plus the reactivation fee.',
  });

  if (reason !== 'member_cancelled') await emailTreasurer(sb, club, plan, why, back);

  await sb.from('audit_log').insert({
    tenant_id: club.tenantId, kind: reason === 'member_cancelled' ? 'plan.cancelled' : 'plan.lapsed',
    entity_type: 'payment_plan', entity_id: plan.id,
    summary: `${plan.family_name}: payment plan ended (${reason.replace('_', ' ')})`,
    actor_kind: reason === 'member_cancelled' ? 'member' : 'system',
    actor_label: reason === 'member_cancelled' ? 'member' : 'cron',
  });
}

/** The Treasurer's one email: still not paid after the retries (or the
 *  deadline). Goes to whoever holds the payments alert. */
async function emailTreasurer(
  sb: SupabaseClient, club: PlanClub, plan: Record<string, unknown>, why: string,
  back: { dues_cents: number },
): Promise<void> {
  try {
    const { recipientsFor } = await import('./positions_db.ts');
    const ids = await recipientsFor(sb, club.tenantId, 'payments');
    if (!ids.length) return;
    const { data: admins } = await sb.from('admin_users').select('email').in('id', ids).eq('active', true);
    const { sendEmail, escHtml } = await import('./send_email.ts');
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px;color:#0f172a">
        <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 8px">Payment plan ended: ${escHtml(String(plan.family_name))}</h2>
        <p style="line-height:1.55">The ${escHtml(String(plan.family_name))} family's membership is canceled because ${escHtml(why)}. They owe ${escHtml(money(back.dues_cents))} and have been emailed how to pay it with the reactivation fee.</p>
        <p style="line-height:1.55">Their gate access goes off and the Facilities Director is asked to turn off their key fobs${plan.enforced_at ? '' : ' when the season starts'}.</p>
        <p style="margin:24px 0"><a href="${club.clubUrl}/club/admin/payments.html#plans" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">See payment plans</a></p>
      </div>`;
    for (const a of admins ?? []) {
      if (!a.email) continue;
      try { await sendEmail({ to: a.email as string, subject: `Payment plan ended: ${plan.family_name}`, html }); }
      catch { /* one bad address must not stop the rest */ }
    }
  } catch (e) { console.error('treasurer email:', (e as Error).message); }
}

/**
 * What a family pays to come back after a lapse or cancellation: everything
 * already due (all of it, once the paid-in-full date has passed) plus the
 * reactivation fee. Plan fees on those payments are included; card fees are
 * worked out on the total by the checkout.
 */
export function reinstateAmount(club: PlanClub, plan: Record<string, unknown>, rows: Inst[]): {
  ids: string[]; dues_cents: number; plan_fee_cents: number; fee_cents: number; total_cents: number;
} {
  const unpaid = rows.filter(r => !isPaid(r));
  const lastDue = unpaid.length ? unpaid[unpaid.length - 1].due_date : '';
  // Nothing overdue (a family that canceled between payments) means only
  // the fee, and the plan carries on from the next date.
  const pick = unpaid.filter(r => r.due_date <= club.today || lastDue <= club.today);
  const dues = pick.reduce((n, r) => n + r.amount_cents, 0);
  const planFees = club.feesWaived ? 0 : pick.reduce((n, r) => n + Number(r.plan_fee_cents ?? 0), 0);
  const fee = plan.status === 'active' ? 0 : Math.max(0, Number(club.cfg.reactivation_fee_cents) || 0);
  return { ids: pick.map(r => r.id), dues_cents: dues, plan_fee_cents: planFees, fee_cents: fee, total_cents: dues + planFees + fee };
}

/** Card fee on top of an amount when the club passes it on. */
export function grossUp(club: PlanClub, cents: number): number {
  return club.passFee && cents > 0 ? Math.ceil((cents + club.fixed) / (1 - club.pct)) : cents;
}

/**
 * A family's plan as they see it: what's paid, the balance, the next charge,
 * and the schedule. The newest plan for the household that hasn't finished.
 */
export async function memberPlanView(sb: SupabaseClient, tenantId: string, householdId: string): Promise<Record<string, unknown> | null> {
  const { data: plans } = await sb.from('payment_plans').select('*')
    .eq('tenant_id', tenantId).eq('household_id', householdId)
    .order('created_at', { ascending: false }).limit(3);
  const plan = (plans ?? []).find(p => p.status !== 'completed') ?? (plans ?? [])[0];
  if (!plan) return null;
  const club = await loadPlanClub(sb, tenantId);
  if (!club) return null;
  const rows = await installmentsOf(sb, plan.id as string);
  return { ...planView(club, plan, rows), year: await planYear(sb, plan) };
}

/** The numbers both the family and the board see for one plan. */
export function planView(club: PlanClub, plan: Record<string, unknown>, rows: Inst[]): Record<string, unknown> {
  const paid = paidCents(rows);
  const total = Number(plan.total_cents);
  const unpaid = rows.filter(r => !isPaid(r));
  const next = plan.status === 'active' ? unpaid[0] ?? null : null;
  const pastDue = plan.status === 'active' && unpaid.some(r => r.status === 'retrying' || r.status === 'failed' || r.due_date < club.today);
  const status = plan.status === 'completed' ? 'paid_in_full'
    : plan.status === 'cancelled' ? 'cancelled'
    : plan.status === 'lapsed' ? 'lapsed'
    : pastDue ? 'past_due' : 'current';
  const fob = plan.enforced_at ? 'turn_off' : (plan.access_at || plan.status === 'completed') ? 'on'
    : (plan.status === 'lapsed' || plan.status === 'cancelled') ? 'off' : 'not_yet';
  const back = plan.status === 'lapsed' || plan.status === 'cancelled' ? reinstateAmount(club, plan, rows) : null;
  return {
    id: plan.id, status, family_name: plan.family_name, household_id: plan.household_id,
    primary_email: plan.primary_email, ended_reason: plan.ended_reason ?? null,
    total_cents: total, paid_cents: paid, balance_cents: total - paid,
    // What "Pay off" and "Reinstate" actually charge, card fee included.
    payoff_charge_cents: grossUp(club, total - paid),
    today_cents: plan.today_cents ?? 0, payoff_month: plan.payoff_month ?? null,
    payments: rows.length,
    next: next ? { date: next.due_date, dues_cents: next.amount_cents, charge_cents: chargeFor(next, club.feesWaived) } : null,
    fob, access_when: club.cfg.access_when,
    reinstate: back ? { dues_cents: back.dues_cents, fee_cents: back.fee_cents, plan_fee_cents: back.plan_fee_cents, total_cents: back.total_cents, charge_cents: grossUp(club, back.total_cents) } : null,
    card_saved: !!plan.stripe_payment_method_id,
    test_card: String(plan.stripe_payment_method_id ?? '').startsWith('sim_'),
    schedule: rows.map(r => ({
      id: r.id, sequence: r.sequence, due_date: r.due_date, dues_cents: r.amount_cents,
      plan_fee_cents: club.feesWaived ? 0 : Number(r.plan_fee_cents ?? 0), card_fee_cents: Number(r.card_fee_cents ?? 0),
      charge_cents: chargeFor(r, club.feesWaived), status: r.status, paid_at: r.paid_at ?? null,
      last_error: r.last_error ?? null,
    })),
  };
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

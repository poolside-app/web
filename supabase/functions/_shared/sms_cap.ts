// =============================================================================
// sms_cap.ts — annual SMS segment allowance + audit logging
// =============================================================================
// Imported by every edge function that fires Twilio SMS. Single source of
// truth for: (1) which plan gets which allowance, (2) which categories draw
// on it, (3) the usage query + the log insert.
//
// Metered in SEGMENTS, not messages (changed 2026-09-07). The allowance used
// to count rows in sms_log — one row per recipient regardless of length —
// while Twilio bills per 160-character GSM-7 segment, dropping to 70 if the
// message contains any non-GSM character. So one emoji tripled the real cost
// of a blast while consuming exactly the same allowance. Worst case on Pro
// was ~$747/yr of Twilio inside a plan that includes texting.
//
// ANNUAL, not monthly. Pool clubs blast hard from May to September and go
// quiet the rest of the year; a monthly cap wasted most of the budget and
// then pinched in exactly the weeks it was needed. Calendar year, so it is
// easy to state and easy to reason about.
//
// Categories:
//   auth           never counted — capping sign-in would lock members out
//   transactional  never counted — approvals, receipts, gate alerts
//   reminder       never counted as of 2026-09-07. Dues reminders are the
//                  product working, not the club broadcasting. Capping them
//                  meant a club that overspent on blasts stopped chasing its
//                  own dues — breaking the thing it pays us for. ~$10/season.
//   campaign       counted. This is the discretionary one: a club choosing
//                  to text everybody, which is the only spend it controls.
//
// Allowances are sized at roughly 8% of plan revenue at Twilio's $0.0083 a
// segment, so a club that spends its entire allowance is still comfortably
// profitable.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { inFreeSeason } from './plan_caps.ts';

export type SmsCategory = 'auth' | 'transactional' | 'campaign' | 'reminder';

/** Segments per CALENDAR YEAR, by plan. */
export const PLAN_CAPS: Record<string, number> = {
  free:        3000,   // free first season + legacy 'free' tenants
  starter:     6000,   // $900 plan  -> ~$50 of Twilio at full spend
  pro:        15000,   // $2,400     -> ~$125
  enterprise: 25000,   // $4,200     -> ~$208. Was identical to Pro, which
                       // made no sense for a plan with unlimited households.
};

export function capForPlan(plan: string | null | undefined): number {
  return PLAN_CAPS[String(plan || 'free').toLowerCase()] ?? PLAN_CAPS.free;
}

export function isCapped(category: SmsCategory): boolean {
  return category === 'campaign';
}

function startOfUtcYear(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}
function startOfNextUtcYear(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear() + 1, 0, 1));
}

export type SmsCapStatus = {
  used: number;
  cap: number;
  category_uncapped: boolean;     // true when caller passes auth/transactional
  remaining: number;              // cap - used (clamped >= 0)
  blocked: boolean;               // true if a campaign send would exceed cap
  days_until_reset: number;
  // Purchased top-up, spent only once the yearly allowance is gone. A club
  // that runs out mid-season can keep going without upgrading a whole tier
  // for one busy month.
  credits: number;
  using_credits: boolean;         // this send will draw on the top-up balance
};

// Returns the tenant's current capped usage and whether further sends in the
// given category are allowed. category 'auth'/'transactional' always allows.
export async function checkSmsCap(
  sb: SupabaseClient,
  tenantId: string,
  category: SmsCategory,
  plan: string | null | undefined,
  /** Segments the caller is about to send. Checked against what's left. */
  segments = 1,
): Promise<SmsCapStatus> {
  // Resolve the allowance BEFORE the category shortcut, because a trialling
  // club's plan is not what it pays for.
  //
  // tenant_signup takes the plan straight from the client, and home.html
  // links signup.html?plan=enterprise — so anyone could click "Start free"
  // under Enterprise and, paying nothing for a year, draw on the 25,000
  // allowance that plan is meant to fund. About $207 of Twilio on a club
  // that has not paid a penny. Households are deliberately uncapped during
  // the free season because they cost nothing to hold; texts are not, so a
  // free season gets the free-season allowance whatever plan was selected.
  const { data: tenantRow } = await sb.from('tenants')
    .select('status, trial_ends_at, sms_credits').eq('id', tenantId).maybeSingle();
  const trialling = inFreeSeason(
    tenantRow?.status as string | null,
    tenantRow?.trial_ends_at as string | null,
  );
  const cap = trialling ? PLAN_CAPS.free : capForPlan(plan);

  if (!isCapped(category)) {
    return {
      used: 0, cap, category_uncapped: true,
      remaining: cap, blocked: false,
      days_until_reset: daysUntilReset(),
      credits: 0, using_credits: false,
    };
  }
  // Sum SEGMENTS, not rows. Only capped categories are summed, so the
  // filter and the allowance agree about what is being measured.
  const since = startOfUtcYear().toISOString();
  const { data: rows } = await sb.from('sms_log')
    .select('segments')
    .eq('tenant_id', tenantId)
    .eq('category', 'campaign')
    .gte('sent_at', since);
  const used = (rows ?? []).reduce(
    (n, r) => n + Math.max(1, Number((r as { segments?: number }).segments ?? 1)), 0);

  // Judge the send that is about to happen, not just what has already gone.
  // A 3-segment blast with 2 segments left must not slip through.
  const want = Math.max(1, Math.trunc(segments));
  const remaining = Math.max(0, cap - used);
  const overAllowance = remaining < want;

  // Already fetched above — no second round trip.
  const credits = overAllowance ? Number(tenantRow?.sms_credits ?? 0) : 0;

  return {
    used, cap, category_uncapped: false,
    remaining,
    // Blocked only once the allowance AND the purchased balance are too
    // small for this message. Credits are denominated in segments too.
    blocked: overAllowance && credits < want,
    using_credits: overAllowance && credits >= want,
    credits,
    days_until_reset: daysUntilReset(),
  };
}

/**
 * Spend purchased credits, denominated in segments. Called only after a send
 * actually went out while over the annual allowance, so a club is never
 * charged for a text a carrier refused. The RPC does a guarded, all-or-
 * nothing update rather than read-then-write: two blasts running at once
 * must not both spend the last credit, and a 3-segment message must never
 * half-charge against a 2-credit balance.
 */
export async function consumeSmsCredit(
  sb: SupabaseClient,
  tenantId: string,
  segments = 1,
): Promise<boolean> {
  const { data } = await sb.rpc('consume_sms_credits', {
    p_tenant: tenantId, p_n: Math.max(1, Math.trunc(segments)),
  });
  return data === true;
}

function daysUntilReset(): number {
  const now = new Date();
  const next = startOfNextUtcYear(now);
  return Math.ceil((next.getTime() - now.getTime()) / 86400_000);
}

// =============================================================================
// Global kill-switch caps — apply to EVERY category (auth + transactional
// included). The per-tenant cap above intentionally lets auth/transactional
// through because they're load-bearing for the app working. These extra
// global limits exist as a safety net against runaway loops, compromised
// keys, or accidental test blasts. They are deliberately low during early
// production so a bug can't spend $$ before we notice.
//
// Both caps are configurable via Supabase secrets:
//   SMS_GLOBAL_DAILY_CAP        (default 25) — total successful sends/24h
//   SMS_PER_RECIPIENT_HOUR_CAP  (default 5)  — successful sends/hour to one #
// =============================================================================

export type GlobalCapStatus = {
  blocked: boolean;
  reason?: 'global_daily' | 'per_recipient_hour';
  used: number;
  cap: number;
};

export async function checkGlobalSmsKillSwitch(
  sb: SupabaseClient,
  toPhone: string,
  opts: {
    /**
     * Skip the platform-wide daily cap for an operational alert that is
     * itself the product (currently only gate-outage escalation). The
     * per-recipient hourly cap still applies, so an exempt caller stuck in
     * a loop still cannot hammer one phone. See send_sms.ts `critical`.
     */
    skipDailyCap?: boolean;
  } = {},
): Promise<GlobalCapStatus> {
  const dailyCap = Number(Deno.env.get('SMS_GLOBAL_DAILY_CAP') ?? '25');
  const hourCap  = Number(Deno.env.get('SMS_PER_RECIPIENT_HOUR_CAP') ?? '5');

  if (dailyCap > 0 && !opts.skipDailyCap) {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    const { count } = await sb.from('sms_log')
      .select('*', { count: 'exact', head: true })
      .eq('success', true)
      .gte('sent_at', since);
    const used = count ?? 0;
    if (used >= dailyCap) {
      return { blocked: true, reason: 'global_daily', used, cap: dailyCap };
    }
  }

  if (hourCap > 0 && toPhone) {
    const since = new Date(Date.now() - 3600_000).toISOString();
    const { count } = await sb.from('sms_log')
      .select('*', { count: 'exact', head: true })
      .eq('success', true)
      .eq('to_phone', toPhone)
      .gte('sent_at', since);
    const used = count ?? 0;
    if (used >= hourCap) {
      return { blocked: true, reason: 'per_recipient_hour', used, cap: hourCap };
    }
  }

  return { blocked: false, used: 0, cap: dailyCap };
}

// Insert one row into sms_log. Caller is expected to call this AFTER each
// Twilio attempt (success or failure). Failures are logged so admins can
// see Twilio errors in their audit trail without inflating the cap counter
// for capped categories that didn't actually send.
export async function recordSms(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    category: SmsCategory;
    toPhone: string;
    success: boolean;
    error?: string | null;
    source?: string;
    /** Billable Twilio segments. Defaults to 1 for callers that don't
     *  measure — the meter then undercounts rather than over-charging. */
    segments?: number;
  },
): Promise<void> {
  await sb.from('sms_log').insert({
    tenant_id: args.tenantId,
    category: args.category,
    to_phone: args.toPhone,
    success: args.success,
    error: args.error ?? null,
    source: args.source ?? null,
    segments: Math.max(1, Math.trunc(args.segments ?? 1)),
  });
}

// =============================================================================
// sms_cap.ts — monthly SMS cap enforcement + audit logging
// =============================================================================
// Imported by every edge function that fires Twilio SMS. Single source of
// truth for: (1) which tenant plans get which monthly cap, (2) which
// categories count against the cap, (3) the actual count + insert.
//
// Categories — auth + transactional NEVER counted (would brick app or hurt
// trust). Campaign + reminder are counted and gated.
//
// Plan → cap table mirrors project_sms_caps memory:
//   free:       250
//   starter:    1000
//   pro:        2500
//   enterprise: 2500
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type SmsCategory = 'auth' | 'transactional' | 'campaign' | 'reminder';

export const PLAN_CAPS: Record<string, number> = {
  free: 250,
  starter: 1000,
  pro: 2500,
  enterprise: 2500,
};

export function capForPlan(plan: string | null | undefined): number {
  return PLAN_CAPS[String(plan || 'free').toLowerCase()] ?? PLAN_CAPS.free;
}

export function isCapped(category: SmsCategory): boolean {
  return category === 'campaign' || category === 'reminder';
}

function startOfUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function startOfNextUtcMonth(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
}

export type SmsCapStatus = {
  used: number;
  cap: number;
  category_uncapped: boolean;     // true when caller passes auth/transactional
  remaining: number;              // cap - used (clamped >= 0)
  blocked: boolean;               // true if a campaign send would exceed cap
  days_until_reset: number;
};

// Returns the tenant's current capped usage and whether further sends in the
// given category are allowed. category 'auth'/'transactional' always allows.
export async function checkSmsCap(
  sb: SupabaseClient,
  tenantId: string,
  category: SmsCategory,
  plan: string | null | undefined,
): Promise<SmsCapStatus> {
  const cap = capForPlan(plan);
  if (!isCapped(category)) {
    return {
      used: 0, cap, category_uncapped: true,
      remaining: cap, blocked: false,
      days_until_reset: daysUntilReset(),
    };
  }
  const since = startOfUtcMonth().toISOString();
  const { count } = await sb.from('sms_log')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .neq('category', 'auth')
    .neq('category', 'transactional')
    .gte('sent_at', since);
  const used = count ?? 0;
  return {
    used, cap, category_uncapped: false,
    remaining: Math.max(0, cap - used),
    blocked: used >= cap,
    days_until_reset: daysUntilReset(),
  };
}

function daysUntilReset(): number {
  const now = new Date();
  const next = startOfNextUtcMonth(now);
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
): Promise<GlobalCapStatus> {
  const dailyCap = Number(Deno.env.get('SMS_GLOBAL_DAILY_CAP') ?? '25');
  const hourCap  = Number(Deno.env.get('SMS_PER_RECIPIENT_HOUR_CAP') ?? '5');

  if (dailyCap > 0) {
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
  },
): Promise<void> {
  await sb.from('sms_log').insert({
    tenant_id: args.tenantId,
    category: args.category,
    to_phone: args.toPhone,
    success: args.success,
    error: args.error ?? null,
    source: args.source ?? null,
  });
}

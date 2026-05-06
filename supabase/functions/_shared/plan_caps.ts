// =============================================================================
// plan_caps.ts — single source of truth for plan-tier capacity gates
// =============================================================================
// Capacity caps (households per tier). Free Forever for ≤30; everything past
// that requires a paid plan. NO feature paywalls — every tier gets every
// feature; only headcount differs. SMS caps live in _shared/sms_cap.ts.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const PLAN_HOUSEHOLD_CAPS: Record<string, number> = {
  free:       20,    // matches pricing memory ("Free Forever ≤20 households")
  starter:    100,
  pro:        300,
  enterprise: Number.POSITIVE_INFINITY,
};

export const PLAN_LABELS: Record<string, string> = {
  free:       'Free Forever',
  starter:    'Starter',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

export function householdCap(plan: string | null | undefined): number {
  const p = String(plan || 'free').toLowerCase();
  return PLAN_HOUSEHOLD_CAPS[p] ?? PLAN_HOUSEHOLD_CAPS.free;
}

export function planLabel(plan: string | null | undefined): string {
  const p = String(plan || 'free').toLowerCase();
  return PLAN_LABELS[p] ?? PLAN_LABELS.free;
}

export type CapStatus = {
  count: number;
  cap: number;             // POSITIVE_INFINITY if unlimited
  remaining: number;       // POSITIVE_INFINITY if unlimited; cap - count otherwise
  at_cap: boolean;
  percent: number;         // 0-100; 100 if at_cap
  plan: string;
  plan_label: string;
};

// Count active households for a tenant and compare against the plan cap.
// Used both for enforcement (block creation) and reporting (admin ticker).
// Provider-side overrides on the tenants row (plan_label_override +
// household_cap_override) win over the default plan tier — that's how a
// grandfathered or comp tenant gets unlimited households without changing
// their `plan` slug (which still drives billing-side decisions).
export async function getHouseholdCapStatus(
  sb: SupabaseClient,
  tenantId: string,
  plan: string | null | undefined,
): Promise<CapStatus> {
  // Pull both the active-household count and the override columns in
  // parallel. One round-trip per call already; can't easily merge.
  const [{ count }, tenantRes] = await Promise.all([
    sb.from('households').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('active', true),
    sb.from('tenants')
      .select('plan_label_override, household_cap_override')
      .eq('id', tenantId).maybeSingle(),
  ]);
  const used = count ?? 0;
  const labelOverride = (tenantRes.data?.plan_label_override as string | null) ?? null;
  const capOverride   = (tenantRes.data?.household_cap_override as number | null) ?? null;

  // Cap precedence: override → plan default. Sentinel: a huge override value
  // (e.g. 999999) acts as "unlimited" for display purposes.
  const cap = capOverride != null
    ? (capOverride >= 100000 ? Number.POSITIVE_INFINITY : capOverride)
    : householdCap(plan);
  const at_cap = used >= cap;
  const remaining = cap === Number.POSITIVE_INFINITY
    ? Number.POSITIVE_INFINITY
    : Math.max(0, cap - used);
  const percent = cap === Number.POSITIVE_INFINITY
    ? 0
    : Math.min(100, Math.round((used / cap) * 100));
  return {
    count: used,
    cap,
    remaining,
    at_cap,
    percent,
    plan: String(plan || 'free').toLowerCase(),
    plan_label: labelOverride || planLabel(plan),
  };
}

// JSON-safe variant: serializes Infinity as null so it survives JSON.stringify
// (which would otherwise produce `null` silently with no flag indicating
// "unlimited" vs "0 remaining"). Front-end reads `unlimited: true` to render
// the right ticker copy.
export type CapStatusJson = {
  count: number;
  cap: number | null;       // null = unlimited
  remaining: number | null; // null = unlimited
  unlimited: boolean;
  at_cap: boolean;
  percent: number;
  plan: string;
  plan_label: string;
};
export function capStatusToJson(s: CapStatus): CapStatusJson {
  const unlimited = s.cap === Number.POSITIVE_INFINITY;
  return {
    count: s.count,
    cap: unlimited ? null : s.cap,
    remaining: unlimited ? null : s.remaining,
    unlimited,
    at_cap: s.at_cap,
    percent: s.percent,
    plan: s.plan,
    plan_label: s.plan_label,
  };
}

// =============================================================================
// plan_caps.ts — single source of truth for plan-tier capacity gates
// =============================================================================
// Capacity caps (households per tier). NO feature paywalls — every tier gets
// every feature; only headcount differs. SMS caps live in _shared/sms_cap.ts.
//
// The "Free Forever ≤20 households" tier was retired 2026-09-07 and replaced
// by a free FIRST SEASON. Twenty households is smaller than almost any real
// pool club, so the old tier mostly advertised a plan nobody could actually
// run a club on; a free first season is a real trial of the whole product.
//
// A trialling club has NO cap — that is the point of the offer, and a cap
// would make "free season" false for any club above the number. Enforcement
// lives in getHouseholdCapStatus, because until today nothing anywhere read
// trial_ends_at: it was written at signup, shown on screen, and never
// checked. Bishop's trial expired in June 2026 with no effect whatsoever.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const PLAN_HOUSEHOLD_CAPS: Record<string, number> = {
  // Legacy value. Tenants created before the free tier was retired still
  // carry plan='free'; once their trial ends they land on the Starter cap
  // rather than being locked out mid-season, and get an upgrade prompt.
  free:       75,
  starter:    75,    // tightened 100->75 (2026-05-18) so median 100-150 cluster lands in Pro
  pro:        200,   // dropped 300->200 (2026-05-18) — clubs actually cluster at 100-150
  enterprise: Number.POSITIVE_INFINITY,
};

export const PLAN_LABELS: Record<string, string> = {
  free:       'Trial ended',
  starter:    'Starter',
  pro:        'Pro',
  enterprise: 'Enterprise',
};

/** Shown while a club is inside its free first season. */
export const TRIAL_LABEL = 'First season free';

/** True while the club is still inside its free first season. */
export function inFreeSeason(
  status: string | null | undefined,
  trialEndsAt: string | null | undefined,
): boolean {
  if (String(status || '').toLowerCase() !== 'trial') return false;
  if (!trialEndsAt) return true;   // no end date recorded = still trialling
  const end = new Date(trialEndsAt).getTime();
  return Number.isFinite(end) ? end > Date.now() : true;
}

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
      .select('plan_label_override, household_cap_override, status, trial_ends_at')
      .eq('id', tenantId).maybeSingle(),
  ]);
  const used = count ?? 0;
  const labelOverride = (tenantRes.data?.plan_label_override as string | null) ?? null;
  const capOverride   = (tenantRes.data?.household_cap_override as number | null) ?? null;
  const trialling = inFreeSeason(
    tenantRes.data?.status as string | null,
    tenantRes.data?.trial_ends_at as string | null,
  );

  // Cap precedence: explicit override → free first season → plan default.
  // The override stays on top so a comped or grandfathered club keeps its
  // capacity after the trial window closes.
  const cap = capOverride != null
    ? (capOverride >= 100000 ? Number.POSITIVE_INFINITY : capOverride)
    : trialling
      ? Number.POSITIVE_INFINITY
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
    plan_label: labelOverride || (trialling ? TRIAL_LABEL : planLabel(plan)),
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

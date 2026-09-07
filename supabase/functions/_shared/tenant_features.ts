// =============================================================================
// tenant_features.ts — is a feature switched on for this club?
// =============================================================================
// The admin nav hides a feature's tab client-side (js/admin-flags.js), but the
// PUBLIC endpoints never checked the flag. So a club that unticked Programs in
// Settings still had every program listed on its member home and its public
// club page, and members could still book them. The switch looked like it
// worked because the *admin* tab disappeared.
//
// Defaults must match js/admin-flags.js FEATURE_NAV. If they drift, the club's
// admin nav and its members disagree about whether a feature exists.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const FEATURE_DEFAULTS: Record<string, boolean> = {
  parties:              true,
  programs:             true,
  volunteer:            true,
  campaigns:            true,
  lifeguard_scheduling: false,
};

/**
 * Read one feature flag for a tenant.
 *
 * `programs` carries a legacy alias: it was called `swim_lessons` before the
 * feature was generalised, and clubs configured back then still store that
 * key. settings.html and wizard.html both still read the same fallback chain.
 */
export async function featureEnabled(
  sb: SupabaseClient,
  tenantId: string,
  feature: string,
): Promise<boolean> {
  const { data } = await sb.from('settings')
    .select('value').eq('tenant_id', tenantId).maybeSingle();
  const features = ((data?.value as Record<string, unknown> | undefined)?.features
    ?? {}) as Record<string, unknown>;
  let v = features[feature];
  if (v === undefined && feature === 'programs') v = features.swim_lessons;
  if (typeof v === 'boolean') return v;
  return FEATURE_DEFAULTS[feature] ?? true;
}

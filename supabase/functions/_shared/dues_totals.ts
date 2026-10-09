// =============================================================================
// dues_totals.ts — how many families have paid this season, and how much
// =============================================================================
// Shared by the dues bar on every board page (tenant_admin_auth `me`) and the
// board home's banner (admin_tasks `home`, PLAN.md W).
//
// No denominator on purpose. "118 of 150" invites the question of what 150
// is — active households? including the family that moved away in March? the
// ones mid-application? — and every answer is arguable, which makes the
// headline number arguable too. How many have paid is not.
//
// Paid means confirmed by either route: a Stripe charge that cleared, or a
// Venmo, check or cash payment the treasurer ticked off. Both set the same
// flag, so neither is favored.
//
// The money is derived from each paid household's tier price, because there
// is no payments table to sum — dues arrive four different ways and the only
// thing all four update is that flag. So it is what the club has booked, not
// what has cleared a bank.
//
// Test payments (test mode) aren't money in: they're left out of both
// numbers and reported on their own as test_paid.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { testPaidHouseholds } from './test_payments.ts';
import { sellingYear } from './membership_year.ts';

export type DuesTotals = { season: number; paid: number; collected_cents: number; test_paid: number };

export async function duesTotals(sb: SupabaseClient, tenantId: string, settingsValue: Record<string, unknown>): Promise<DuesTotals> {
  const testIds = await testPaidHouseholds(sb, tenantId);
  // Paid for the current season (PLAN.md U2), so the numbers never mix last
  // season's families into this one's.
  const season = sellingYear(settingsValue);
  const { data: hh } = await sb.from('households')
    .select('id, tier')
    .eq('tenant_id', tenantId).eq('active', true).gte('paid_until_year', season);
  const tiers = (settingsValue.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
  const priceOf = (slug: string | null | undefined) => {
    const t = tiers.find(x => x.slug === slug) ?? tiers[0];
    return Number(t?.price_cents ?? 0) || 0;
  };
  const all = hh ?? [];
  const rows = all.filter(r => !testIds.has(r.id as string));
  return {
    season,
    paid: rows.length,
    collected_cents: rows.reduce((n, r) => n + priceOf(r.tier as string), 0),
    test_paid: all.length - rows.length,
  };
}

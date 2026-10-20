// The fundraiser thermometer's total (PLAN.md BG3, from the 10/20 audit).
//
// raised_cents (what the member home shows) = every verified donation
// recorded in Poolside + outside_cents, the money the board raised outside
// the app (a bake sale, checks it didn't enter one by one). Before, every
// donation recomputed raised_cents from the donations alone, wiping out a
// total the board had typed in.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export function fundraiserRaised(fund: { outside_cents?: unknown } | null | undefined, recordedCents: number): number {
  const outside = Math.max(0, Math.round(Number(fund?.outside_cents ?? 0) || 0));
  return Math.max(0, recordedCents) + outside;
}

/** Recompute and store settings.value.fundraiser.raised_cents. */
export async function recomputeFundraiser(sb: SupabaseClient, tenantId: string): Promise<number> {
  const { data: rows } = await sb.from('donations')
    .select('amount_cents').eq('tenant_id', tenantId).eq('status', 'verified');
  const recorded = (rows ?? []).reduce((acc, r) => acc + (Number(r.amount_cents) || 0), 0);
  const { data: row } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const v = (row?.value as Record<string, unknown> | null) ?? {};
  const fund = (v.fundraiser as Record<string, unknown> | undefined) ?? {};
  const total = fundraiserRaised(fund, recorded);
  await sb.from('settings').update({ value: { ...v, fundraiser: { ...fund, raised_cents: total } } }).eq('tenant_id', tenantId);
  return total;
}

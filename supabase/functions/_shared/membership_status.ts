// =============================================================================
// membership_status.ts — is this family a member right now? (PLAN.md U3)
// =============================================================================
// Doug, 2026-10-08: "starting January of the new year, they are no longer
// members... they can still log in, but it should just pop up saying pay for
// new season now to access all features." A family is a member for the
// current season (Settings → Season) when:
//   - they've paid for it (paid_until_year is the season or later), or
//   - they're on a payment plan for it (Doug: signing up for a plan counts), or
//   - they were members last season and it's not yet January 1 of this one.
// Anyone else can sign in but only use what's in UNPAID_CAN_USE.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** What a family that isn't a member can still use (Doug, 10/8). */
export const UNPAID_CAN_USE = ['family', 'calendar', 'help', 'renew'];

export type MemberStatus = {
  member: boolean;
  season: number;
  /** They should renew for this season (paid only through an earlier one). */
  renew_needed: boolean;
  /** For last season's members: the day they stop being members. */
  grace_until: string | null;
  reason: 'paid' | 'plan' | 'grace' | 'unpaid';
};

export function memberStatus(
  hh: { paid_until_year?: number | null; on_plan_for_season?: boolean | null },
  season: number,
  today: string,
): MemberStatus {
  const paid = Number(hh.paid_until_year ?? 0);
  if (paid >= season) return { member: true, season, renew_needed: false, grace_until: null, reason: 'paid' };
  if (hh.on_plan_for_season) return { member: true, season, renew_needed: false, grace_until: null, reason: 'plan' };
  const cutoff = `${season}-01-01`;
  if (paid >= season - 1 && today < cutoff) return { member: true, season, renew_needed: true, grace_until: cutoff, reason: 'grace' };
  return { member: false, season, renew_needed: true, grace_until: null, reason: 'unpaid' };
}

/** The status for one household, read from the database. */
export async function householdStatus(sb: SupabaseClient, tenantId: string, householdId: string): Promise<MemberStatus> {
  const [{ data: sv }, { data: hh }, { data: tenant }] = await Promise.all([
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('households').select('paid_until_year').eq('id', householdId).eq('tenant_id', tenantId).maybeSingle(),
    sb.from('tenants').select('timezone').eq('id', tenantId).maybeSingle(),
  ]);
  const { sellingYear } = await import('./membership_year.ts');
  const { poolToday, zoneOrDefault } = await import('./pool_time.ts');
  const season = sellingYear(sv?.value ?? {});
  const today = poolToday(zoneOrDefault(tenant?.timezone as string | null | undefined));
  const onPlan = Number(hh?.paid_until_year ?? 0) >= season ? false : await onPlanFor(sb, householdId, season);
  return memberStatus({ paid_until_year: hh?.paid_until_year as number | null, on_plan_for_season: onPlan }, season, today);
}

/** A payment plan, still going, for this season's membership. */
async function onPlanFor(sb: SupabaseClient, householdId: string, season: number): Promise<boolean> {
  const { data: plans } = await sb.from('payment_plans').select('application_id, status')
    .eq('household_id', householdId).in('status', ['active', 'past_due']).limit(5);
  const appIds = (plans ?? []).map(p => p.application_id).filter(Boolean) as string[];
  if (!appIds.length) return false;
  const { count } = await sb.from('applications').select('id', { count: 'exact', head: true })
    .in('id', appIds).eq('membership_year', season);
  return (count ?? 0) > 0;
}

/**
 * The daily run: from January 1 of each club's season, families who aren't
 * members any more get dues_paid_for_year off. Idempotent. Returns how many.
 */
export async function membershipCutoffs(sb: SupabaseClient): Promise<number> {
  const { sellingYear } = await import('./membership_year.ts');
  const { poolToday, zoneOrDefault } = await import('./pool_time.ts');
  const { data: clubs } = await sb.from('tenants').select('id, timezone').not('status', 'in', '("suspended","churned")');
  let n = 0;
  for (const c of (clubs ?? [])) {
    const { data: sv } = await sb.from('settings').select('value').eq('tenant_id', c.id).maybeSingle();
    const season = sellingYear(sv?.value ?? {});
    if (poolToday(zoneOrDefault(c.timezone as string | null)) < `${season}-01-01`) continue;
    const { data: stale } = await sb.from('households').select('id, paid_until_year')
      .eq('tenant_id', c.id).eq('active', true).eq('dues_paid_for_year', true).lt('paid_until_year', season).limit(1000);
    for (const h of (stale ?? [])) {
      if (await onPlanFor(sb, h.id as string, season)) continue;
      await sb.from('households').update({ dues_paid_for_year: false }).eq('id', h.id);
      n++;
    }
  }
  return n;
}

/** The message for a family that isn't a member, for refusals. */
export const NOT_A_MEMBER = (season: number) => `Pay for the ${season} season to use this. You can renew in the app.`;

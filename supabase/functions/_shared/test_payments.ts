// =============================================================================
// test_payments — which households were paid with a test payment
// =============================================================================
// While a club has test payments on, families "pay" with the fake card
// checkout or the Simulate Venmo button, and their households are marked
// paid like any other. So the dues total counted them as money in (D10) and
// the Members list couldn't tell them apart (D7). A test payment leaves one
// of two marks on the family's application:
//   - card:  stripe_session_id starts with 'sim_' (stripe_checkout)
//   - Venmo: an application_actions row whose body is SIM_NOTE, written by
//            applications → simulate_venmo_paid (the same string lives there;
//            scripts/test_screens.mjs checks they match)
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SIM_NOTE = 'Simulated payment (test mode)';

/** Is the club in test mode? Then a payment the board marks received is a
 *  test payment too (PLAN.md AF1b: Doug approved a friend's pretend Venmo
 *  with the regular button, and it was counted as money in). */
export async function clubInTestMode(sb: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const pay = ((data?.value as Record<string, unknown> | undefined)?.payments as Record<string, unknown> | undefined) ?? {};
  return pay.test_mode === true;
}

export async function testPaidHouseholds(sb: SupabaseClient, tenantId: string): Promise<Set<string>> {
  const [{ data: card }, { data: venmo }] = await Promise.all([
    sb.from('applications').select('household_id')
      .eq('tenant_id', tenantId).like('stripe_session_id', 'sim_%').not('household_id', 'is', null),
    sb.from('application_actions').select('application_id')
      .eq('tenant_id', tenantId).eq('body', SIM_NOTE),
  ]);
  const ids = new Set((card ?? []).map(a => a.household_id as string));
  const appIds = [...new Set((venmo ?? []).map(a => a.application_id as string))];
  if (appIds.length) {
    const { data } = await sb.from('applications').select('household_id')
      .in('id', appIds).not('household_id', 'is', null);
    for (const a of data ?? []) ids.add(a.household_id as string);
  }
  return ids;
}

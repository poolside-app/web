// =============================================================================
// stripe_account.ts — switching a club's Stripe account (PLAN.md BN1, BK6)
// =============================================================================
// Bishop starts on a Stripe account in Doug's name, and the club may take it
// over later; and the test-mode account Bishop has now means nothing once the
// live key is in (Stripe answers "No such account"). So a club can connect a
// different account, and an account Stripe doesn't know is set aside for a
// fresh one rather than shown as an error.
//
// Saved cards live on the account that saved them. A family's payment plan or
// auto-renew card can't follow the club to a new account by itself, so the
// switch waits until there are none (test cards aside).
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** Stripe's answer for an account this key can't see: gone, the other mode's,
 *  or disconnected from Poolside. Making a link says "No such account";
 *  looking the account up says the key "does not have access". */
export function isMissingAccount(message: unknown): boolean {
  return /No such account|similar object exists in (test|live) mode|does not have access to account/i.test(String(message ?? ''));
}

export function switchBlocked(n: number): string {
  return `${n} ${n === 1 ? 'family has a card' : 'families have cards'} saved with this Stripe account for a payment plan or auto-renew. Saved cards can't move to a new account by themselves, so email support@poolsideapp.com before switching.`;
}

/** Families with a real card kept on the club's current account. */
export async function savedCards(sb: SupabaseClient, tenantId: string): Promise<number> {
  const [{ count: plans }, { count: renew }] = await Promise.all([
    sb.from('payment_plans').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('status', 'active')
      .not('stripe_payment_method_id', 'is', null).not('stripe_payment_method_id', 'like', 'sim_%'),
    sb.from('households').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId).eq('auto_renew', true)
      .not('auto_renew_pm_id', 'is', null).not('auto_renew_pm_id', 'like', 'sim_%'),
  ]);
  return (plans ?? 0) + (renew ?? 0);
}

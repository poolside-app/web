// Which Poolside payment a Stripe refund or chargeback is about (PLAN.md BG3,
// from the 10/20 audit). Signups are matched in stripe_webhook as before;
// this covers everything else card payments buy: plan payments, parties,
// keyfobs, programs and donations. When nothing matches, the club that owns
// the Stripe account still hears about it, so a chargeback is never silent.
//
// Doug, 10/20: refunds and chargebacks get a to-do only. Nothing here
// changes a payment, a party or a fob.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type PaymentMatch = {
  tenant_id: string;
  /** What was bought, in words: "a plan payment", "a party (Pool Party)". */
  what: string;
  family: string | null;
  link_url: string;
  source_kind: string | null;
  source_id: string | null;
  unmatched?: boolean;
};

async function familyName(sb: SupabaseClient, householdId: unknown): Promise<string | null> {
  if (!householdId) return null;
  const { data } = await sb.from('households').select('family_name').eq('id', String(householdId)).maybeSingle();
  return (data?.family_name as string) ?? null;
}

export async function matchPayment(sb: SupabaseClient, piId: string, accountId?: string | null): Promise<PaymentMatch | null> {
  if (piId) {
    const { data: inst } = await sb.from('payment_plan_installments')
      .select('id, tenant_id, plan_id, sequence').eq('stripe_payment_intent_id', piId).maybeSingle();
    if (inst) {
      const { data: plan } = await sb.from('payment_plans').select('family_name').eq('id', inst.plan_id).maybeSingle();
      return { tenant_id: inst.tenant_id as string, what: `payment ${inst.sequence} of a payment plan`,
        family: (plan?.family_name as string) ?? null, link_url: '/club/admin/upcoming.html',
        source_kind: 'payment_plan_installment', source_id: inst.id as string };
    }
    const { data: party } = await sb.from('party_bookings')
      .select('id, tenant_id, household_id, title').eq('stripe_payment_intent_id', piId).maybeSingle();
    if (party) {
      return { tenant_id: party.tenant_id as string, what: `a party (${party.title ?? 'party'})`,
        family: await familyName(sb, party.household_id), link_url: '/club/admin/parties.html',
        source_kind: 'party_booking', source_id: party.id as string };
    }
    const { data: fobs } = await sb.from('keyfobs')
      .select('id, tenant_id, household_id').eq('stripe_payment_intent_id', piId).limit(10);
    if (fobs && fobs.length) {
      return { tenant_id: fobs[0].tenant_id as string, what: fobs.length === 1 ? 'a keyfob' : `${fobs.length} keyfobs`,
        family: await familyName(sb, fobs[0].household_id), link_url: '/club/admin/keyfobs.html',
        source_kind: 'keyfob', source_id: fobs[0].id as string };
    }
    const { data: booking } = await sb.from('program_bookings')
      .select('id, tenant_id, household_id, participant_name, program_id').eq('stripe_payment_intent_id', piId).maybeSingle();
    if (booking) {
      const { data: prog } = await sb.from('programs').select('name').eq('id', booking.program_id).maybeSingle();
      return { tenant_id: booking.tenant_id as string,
        what: `${prog?.name ?? 'a program'}${booking.participant_name ? ` for ${booking.participant_name}` : ''}`,
        family: await familyName(sb, booking.household_id), link_url: '/club/admin/programs.html',
        source_kind: 'program_booking', source_id: booking.id as string };
    }
    const { data: don } = await sb.from('donations')
      .select('id, tenant_id, donor_name').eq('stripe_payment_intent', piId).maybeSingle();
    if (don) {
      return { tenant_id: don.tenant_id as string, what: 'a donation',
        family: (don.donor_name as string) ?? null, link_url: '/club/admin/donations.html',
        source_kind: 'donation', source_id: don.id as string };
    }
  }
  // Nothing in Poolside matches. Tell the club whose Stripe account it is.
  if (accountId) {
    const { data: t } = await sb.from('tenants').select('id').eq('stripe_account_id', accountId).maybeSingle();
    if (t) {
      return { tenant_id: t.id as string, what: 'a card payment Poolside couldn\'t match', family: null,
        link_url: '/club/admin/payments.html', source_kind: null, source_id: null, unmatched: true };
    }
  }
  return null;
}

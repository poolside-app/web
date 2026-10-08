// =============================================================================
// renewal_quote.ts — what a household owes for the coming season, and how they
// may pay it
// =============================================================================
// Used by two callers who must never disagree: the signed-in renewal page in
// the member portal, and the no-login renewal link a club texts out. If these
// answered differently — different price, different plans — a member forwarding
// a link to their spouse would see a different offer than they did.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sellingYear, renewalOpen, isPaidThrough, opensMonthOf } from './membership_year.ts';
import { feePolicyFor } from './fees.ts';
import { priceFor, type PriceResult } from './membership_price.ts';
import { loadPlanClub } from './plan_ops.ts';
import { quotePlan, type PlanQuote } from './plan_quote.ts';

export type RenewalQuote = {
  year: number;
  open: boolean;
  already_paid: boolean;
  tier_label: string;
  dues_cents: number;
  pass_fee: boolean;
  plans_enabled: boolean;
  /** The payment plan on offer, with the family's choice priced (PLAN.md M). */
  plan: PlanQuote | null;
  /** Retired with count-based plans; kept empty so an old page offers none. */
  options: never[];
  /** Before the card fee: the level's price, any code, their referral
   *  credit, and what's left (H5). What Venmo asks for. */
  price: {
    base_cents: number; discount_cents: number; credit_cents: number; amount_due_cents: number;
    code: string | null; code_label: string | null; code_problem: string | null; note: string | null;
  };
};

export async function quoteRenewal(
  sb: SupabaseClient,
  tenantId: string,
  household: { id?: string | null; tier?: string | null; paid_until_year?: number | null },
  /** The renewal application's price, when there is one (priceApplication). */
  priced?: PriceResult | null,
  /** What the family picked: pay today, paid off by. */
  planChoice?: { today_cents?: number | null; payoff_month?: string | null },
  /** The season, when a renewal link already fixed it. */
  yearOverride?: number | null,
): Promise<RenewalQuote> {
  const { data: settings } = await sb.from('settings')
    .select('value').eq('tenant_id', tenantId).maybeSingle();
  const sv = (settings?.value ?? {}) as Record<string, unknown>;

  // This module exists because the signed-in renewal page and the no-login
  // link once quoted different prices. A fee waiver is the same class of
  // problem in reverse: quoting a plan fee a waived club's members will never
  // be charged would be a promise broken in the other direction.
  const feePolicy = await feePolicyFor(sb, tenantId);

  const year = yearOverride ?? sellingYear(sv);

  // Dues come from the household's tier — the same source the apply form uses,
  // so a renewal never quietly quotes a different number than joining would.
  // Any code and their referral credit come off first (H5).
  const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
  const tier = tiers.find(t => t.slug === household.tier) || tiers[0];
  const price = priced ?? await priceFor(sb, tenantId, sv, {
    tierSlug: household.tier ?? null, householdId: household.id ?? null, isRenewal: true,
  });
  const baseCents = price.amount_due_cents;

  // If the club passes card fees to members, quote the grossed-up figure. The
  // page must never show one number and the checkout another.
  const pay = (sv.payments as Record<string, unknown> | undefined) ?? {};
  const passFee = !!pay.pass_stripe_fee;
  const pct = Number(pay.stripe_pct ?? 2.9) / 100;
  const fixed = Number(pay.stripe_fixed_cents ?? 30);
  const duesCents = passFee && baseCents > 0
    ? Math.ceil((baseCents + fixed) / (1 - pct))
    : baseCents;

  const planCfg = (pay.plan as Record<string, unknown> | undefined) ?? {};
  const plansEnabled = !!planCfg.enabled;

  // The plan is spread over what they owe before the card fee; each payment
  // carries its own card fee (plan_quote.ts).
  let plan: PlanQuote | null = null;
  if (plansEnabled && baseCents > 0) {
    const club = await loadPlanClub(sb, tenantId);
    if (club) {
      plan = quotePlan(club, {
        totalCents: baseCents, tierSlug: household.tier ?? null, year, policy: feePolicy,
        todayCents: planChoice?.today_cents ?? null, payoffMonth: planChoice?.payoff_month ?? null,
      });
    }
  }

  return {
    year,
    open: renewalOpen(sv),
    already_paid: isPaidThrough(household.paid_until_year, year),
    tier_label: (tier?.label as string) ?? household.tier ?? 'Membership',
    dues_cents: duesCents,
    pass_fee: passFee,
    plans_enabled: plansEnabled && !!plan?.available,
    plan,
    options: [],
    price: {
      base_cents: price.base_cents, discount_cents: price.discount_cents,
      credit_cents: price.credit_cents, amount_due_cents: price.amount_due_cents,
      code: price.code, code_label: price.code_label, code_problem: price.code_problem, note: price.note,
    },
  };
}

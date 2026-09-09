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
import { sellingYear, renewalOpen, isPaidThrough } from './membership_year.ts';
import { resolveRules, generateSchedule, suggestedCounts } from './payment_schedule.ts';

import { planFeeTotal, planFeeSchedule } from './fees.ts';

export type RenewalQuote = {
  year: number;
  open: boolean;
  already_paid: boolean;
  tier_label: string;
  dues_cents: number;
  pass_fee: boolean;
  plans_enabled: boolean;
  rules: unknown | null;
  options: Array<{ count: number; installments: unknown[]; plan_fee_cents?: number; plan_fee_per_payment_cents?: number }>;
};

export async function quoteRenewal(
  sb: SupabaseClient,
  tenantId: string,
  household: { tier?: string | null; paid_until_year?: number | null },
): Promise<RenewalQuote> {
  const { data: settings } = await sb.from('settings')
    .select('value').eq('tenant_id', tenantId).maybeSingle();
  const sv = (settings?.value ?? {}) as Record<string, unknown>;

  const year = sellingYear(sv);

  // Dues come from the household's tier — the same source the apply form uses,
  // so a renewal never quietly quotes a different number than joining would.
  const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
  const tier = tiers.find(t => t.slug === household.tier) || tiers[0];
  const baseCents = Number(tier?.price_cents) || 0;

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

  let rules: unknown = null;
  let options: Array<{ count: number; installments: unknown[] }> = [];
  if (plansEnabled && duesCents > 0) {
    const today = new Date().toISOString().slice(0, 10);
    const r = resolveRules(planCfg, year);
    rules = {
      milestones: r.milestones,
      max_installments: r.maxInstallments,
      min_installment_cents: r.minInstallmentCents,
    };
    // Each option carries its plan fee, so the signed-in renewal page and
    // the no-login link quote the same number. This file exists precisely
    // because those two once disagreed about price.
    options = suggestedCounts(r, today).map(count => {
      const gen = generateSchedule({ totalCents: duesCents, rules: r, count, startDate: today });
      if (!gen.ok) return null;
      return {
        count,
        installments: gen.installments,
        plan_fee_cents: planFeeTotal(count),
        plan_fee_per_payment_cents: planFeeSchedule(count)[1] ?? 0,
      };
    }).filter(Boolean) as Array<{ count: number; installments: unknown[] }>;
  }

  return {
    year,
    open: renewalOpen(sv),
    already_paid: isPaidThrough(household.paid_until_year, year),
    tier_label: (tier?.label as string) ?? household.tier ?? 'Membership',
    dues_cents: duesCents,
    pass_fee: passFee,
    plans_enabled: plansEnabled,
    rules,
    options,
  };
}

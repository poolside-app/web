// =============================================================================
// membership_price.ts — an application's price, worked out and stored (H5)
// =============================================================================
// The rules are in pricing.ts. This is the database side: find the code,
// check the referral link, read the family's credit, and store the result on
// the applications row, which card checkout, payment plans, Venmo and the
// "nothing to pay" button all read.
//
// A code use and a spent credit are recorded only once the payment clears
// (recordDiscountUse), so an abandoned checkout doesn't use up a code or
// spend a family's credit.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  priceMembership, codeProblem, normalizeCode, referralSettings,
  type DiscountCode, type Price,
} from './pricing.ts';
import { poolToday, tenantTimeZone } from './pool_time.ts';

// deno-lint-ignore no-explicit-any
type SB = SupabaseClient<any, any, any>;

export type PriceResult = Price & {
  tier_label: string;
  code: string | null;
  code_label: string | null;
  /** Why a typed code wasn't used, to show under the box. */
  code_problem: string | null;
  /** "The Smiths" when the referral discount applied. */
  referral_family: string | null;
};

const CODE_FIELDS = 'id, code, label, amount_cents, percent_off, expires_on, max_uses, active';

export async function loadCode(sb: SB, tenantId: string, by: { raw?: string | null; id?: string | null }): Promise<DiscountCode | null> {
  if (by.id) {
    const { data } = await sb.from('discount_codes').select(CODE_FIELDS).eq('tenant_id', tenantId).eq('id', by.id).maybeSingle();
    return (data as DiscountCode | null) ?? null;
  }
  const code = normalizeCode(by.raw);
  if (!code) return null;
  const { data } = await sb.from('discount_codes').select(CODE_FIELDS).eq('tenant_id', tenantId).eq('code', code).maybeSingle();
  return (data as DiscountCode | null) ?? null;
}

/** Families who have paid with this code (not counting `exceptAppId`). */
export async function codeUses(sb: SB, codeId: string, exceptAppId?: string | null): Promise<number> {
  let q = sb.from('applications').select('id', { count: 'exact', head: true })
    .eq('discount_code_id', codeId).not('discount_recorded_at', 'is', null);
  if (exceptAppId) q = q.neq('id', exceptAppId);
  const { count } = await q;
  return count ?? 0;
}

/** Has anyone with this email or phone ever been a member here? Not
 *  counting `exceptHousehold`: once approved, a new family's own members
 *  exist and would otherwise count against them. */
export async function wasMember(
  sb: SB, tenantId: string, email?: string | null, phone?: string | null, exceptHousehold?: string | null,
): Promise<boolean> {
  if (email) {
    let q = sb.from('household_members').select('id')
      .eq('tenant_id', tenantId).ilike('email', email.trim().toLowerCase());
    if (exceptHousehold) q = q.neq('household_id', exceptHousehold);
    const { data } = await q.limit(1);
    if (data && data.length) return true;
  }
  if (phone) {
    let q = sb.from('household_members').select('id')
      .eq('tenant_id', tenantId).eq('phone_e164', phone);
    if (exceptHousehold) q = q.neq('household_id', exceptHousehold);
    const { data } = await q.limit(1);
    if (data && data.length) return true;
  }
  return false;
}

/** The referral discount a new family gets through a member's link. */
export async function referralOff(
  sb: SB, tenantId: string, settingsValue: unknown,
  args: { referralCode?: string | null; email?: string | null; phone?: string | null; householdId?: string | null },
): Promise<{ cents: number; family: string | null }> {
  const raw = String(args.referralCode ?? '').trim().toUpperCase();
  if (!raw) return { cents: 0, family: null };
  const { data: rc } = await sb.from('referral_codes')
    .select('id, household_id, active').eq('tenant_id', tenantId).eq('code', raw).maybeSingle();
  if (!rc || !rc.active) return { cents: 0, family: null };
  // For families new to the club. A lapsed member coming back through a
  // friend's link pays the regular price.
  if (await wasMember(sb, tenantId, args.email, args.phone, args.householdId)) return { cents: 0, family: null };
  const { data: hh } = await sb.from('households').select('family_name').eq('id', rc.household_id).maybeSingle();
  return { cents: referralSettings(settingsValue).new_family_cents, family: (hh?.family_name as string | null) ?? null };
}

export type PriceInput = {
  tierSlug: string | null;
  householdId?: string | null;
  isRenewal?: boolean;
  referralCode?: string | null;
  email?: string | null;
  phone?: string | null;
  /** A code the family just typed. '' clears it. */
  code?: string | null;
  /** A code already on the application. */
  codeId?: string | null;
  exceptAppId?: string | null;
};

export async function priceFor(sb: SB, tenantId: string, settingsValue: unknown, input: PriceInput): Promise<PriceResult> {
  const sv = (settingsValue ?? {}) as Record<string, unknown>;
  const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];
  const tier = tiers.find(t => t.slug === input.tierSlug) || tiers[0];
  const base = Number(tier?.price_cents) || 0;
  const today = poolToday(await tenantTimeZone(sb, tenantId));

  let code: DiscountCode | null = null;
  let problem: string | null = null;
  const typed = input.code != null && String(input.code).trim() !== '';
  if (typed || input.codeId) {
    const found = await loadCode(sb, tenantId, typed ? { raw: input.code } : { id: input.codeId });
    problem = codeProblem(found, today, found ? await codeUses(sb, found.id, input.exceptAppId) : 0);
    if (!problem) code = found;
  }

  const ref = input.isRenewal
    ? { cents: 0, family: null }
    : await referralOff(sb, tenantId, sv, input);

  let credit = 0;
  if (input.isRenewal && input.householdId) {
    const { data: hh } = await sb.from('households').select('referral_credits_cents').eq('id', input.householdId).maybeSingle();
    credit = Number(hh?.referral_credits_cents) || 0;
  }

  const price = priceMembership({ baseCents: base, code, referralOffCents: ref.cents, creditCents: credit });
  return {
    ...price,
    tier_label: (tier?.label as string) || 'Membership',
    code: code?.code ?? null,
    code_label: code?.label ?? null,
    code_problem: typed ? problem : null,
    referral_family: price.discount_kind === 'referral' ? ref.family : null,
  };
}

const APP_PRICE_FIELDS = 'id, tenant_id, tier_slug, household_id, is_renewal, referral_code, primary_email, primary_phone, payment_status, '
  + 'discount_code_id, discount_recorded_at, base_cents, discount_cents, discount_kind, credit_cents, amount_due_cents';

/**
 * Work out an application's price and store it. `code` is what the family
 * just typed ('' removes their code); leave it out to keep the one on file.
 * A code that doesn't work leaves the price as it was and says why. Once the
 * payment has cleared, the stored price stands.
 */
export async function priceApplication(
  sb: SB, appId: string, opts: { code?: string | null } = {},
): Promise<(PriceResult & { application_id: string }) | null> {
  const { data: app } = await sb.from('applications').select(APP_PRICE_FIELDS).eq('id', appId).maybeSingle();
  if (!app) return null;

  const { data: settings } = await sb.from('settings').select('value').eq('tenant_id', app.tenant_id).maybeSingle();
  const input: PriceInput = {
    tierSlug: app.tier_slug as string | null,
    householdId: app.household_id as string | null,
    isRenewal: !!app.is_renewal,
    referralCode: app.referral_code as string | null,
    email: app.primary_email as string | null,
    phone: app.primary_phone as string | null,
    exceptAppId: app.id as string,
  };

  if (app.discount_recorded_at || app.payment_status === 'paid') {
    const stored = await priceFor(sb, app.tenant_id as string, settings?.value, { ...input, codeId: app.discount_code_id as string | null });
    return {
      ...stored,
      base_cents: Number(app.base_cents ?? stored.base_cents),
      discount_cents: Number(app.discount_cents ?? 0),
      discount_kind: (app.discount_kind as Price['discount_kind']) ?? null,
      discount_code_id: (app.discount_code_id as string | null) ?? null,
      credit_cents: Number(app.credit_cents ?? 0),
      amount_due_cents: Number(app.amount_due_cents ?? stored.amount_due_cents),
      note: null, code_problem: null,
      application_id: app.id as string,
    };
  }

  const wantsNew = opts.code !== undefined;
  let res = await priceFor(sb, app.tenant_id as string, settings?.value, wantsNew
    ? { ...input, code: opts.code ?? '' }
    : { ...input, codeId: app.discount_code_id as string | null });
  if (wantsNew && res.code_problem && app.discount_code_id) {
    // Keep the code they already had rather than dropping it for a typo.
    const kept = await priceFor(sb, app.tenant_id as string, settings?.value, { ...input, codeId: app.discount_code_id as string });
    res = { ...kept, code_problem: res.code_problem };
  }

  await sb.from('applications').update({
    base_cents: res.base_cents,
    discount_cents: res.discount_cents,
    discount_kind: res.discount_kind,
    discount_code_id: res.discount_code_id,
    credit_cents: res.credit_cents,
    amount_due_cents: res.amount_due_cents,
  }).eq('id', app.id);

  return { ...res, application_id: app.id as string };
}

/**
 * The payment cleared: count the code use and spend the credit, once.
 * Safe to call from every place a payment can clear.
 */
export async function recordDiscountUse(sb: SB, appId: string): Promise<void> {
  const now = new Date().toISOString();
  const { data: app } = await sb.from('applications')
    .update({ discount_recorded_at: now })
    .eq('id', appId).is('discount_recorded_at', null)
    .select('id, tenant_id, household_id, family_name, credit_cents, discount_cents, discount_kind, discount_code_id')
    .maybeSingle();
  if (!app) return;   // already recorded

  const credit = Number(app.credit_cents) || 0;
  if (credit > 0 && app.household_id) {
    const { data: hh } = await sb.from('households').select('referral_credits_cents').eq('id', app.household_id).maybeSingle();
    await sb.from('households')
      .update({ referral_credits_cents: Math.max(0, (Number(hh?.referral_credits_cents) || 0) - credit) })
      .eq('id', app.household_id);
  }

  const discount = Number(app.discount_cents) || 0;
  if (credit > 0 || discount > 0) {
    let codeName = '';
    if (app.discount_code_id) {
      const { data: c } = await sb.from('discount_codes').select('code').eq('id', app.discount_code_id).maybeSingle();
      codeName = c?.code ? ` (code ${c.code})` : '';
    }
    const parts = [
      discount > 0 ? `$${(discount / 100).toFixed(2)} ${app.discount_kind === 'code' ? 'discount' + codeName : 'referral discount'}` : '',
      credit > 0 ? `$${(credit / 100).toFixed(2)} referral credit` : '',
    ].filter(Boolean);
    try {
      await sb.from('audit_log').insert({
        tenant_id: app.tenant_id, kind: 'membership.discount_used',
        entity_type: 'application', entity_id: app.id,
        summary: `${app.family_name || 'A family'} paid with ${parts.join(' and ')}`,
        actor_kind: 'system',
        metadata: { discount_cents: discount, discount_kind: app.discount_kind, discount_code_id: app.discount_code_id, credit_cents: credit },
      });
    } catch { /* the record above is what counts */ }
  }
}

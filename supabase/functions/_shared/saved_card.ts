// =============================================================================
// saved_card.ts — a family's saved card, and removing it (PLAN.md CM5)
// =============================================================================
// Doug 11/8: "have a button to remove their card… make sure though it will
// auto reject all future payments etc.". A card is kept in two places: on the
// household for auto-renew (auto_renew_customer_id / auto_renew_pm_id) and on
// each payment plan (stripe_customer_id / stripe_payment_method_id), both on
// Stripe customers in the club's own Stripe account.
//
// Removing takes every card off those customers at Stripe (an old one left
// after "Update card" too), clears both places, and turns auto-renew off with
// its consent kept as revoked. After that nothing can charge them: approving a
// renewal with a saved card refuses without one, and the daily run has no
// card to use.
//
// A plan with payments left keeps its card (Doug: "Swap only until paid….
// Unless they cancel… no refund on payments"): they can switch cards, pay off
// the rest, or cancel the plan, and then remove it.
// =============================================================================

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one

/** One Stripe API call on the club's account. */
export type StripeCall = (path: string, method?: 'GET' | 'POST') => Promise<{ ok: boolean; status: number; data: any }>;

export function stripeCaller(key: string | undefined | null, account: string | null | undefined): StripeCall | null {
  if (!key || !account) return null;
  return async (path, method = 'GET') => {
    const r = await fetch(`https://api.stripe.com/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${key}`, 'Stripe-Account': account },
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  };
}

export const PLAN_KEEPS_CARD = 'Your payment plan charges this card for the payments left. You can switch to another card, or pay off the rest, and then remove it. Or cancel your plan: your membership ends right away and nothing you\'ve paid is refunded.';

export type CardState = {
  /** Every saved card we know of, test-payment ones included. */
  pms: string[];
  /** The Stripe customers they're on (test ones left out). */
  customers: string[];
  /** The card to name on screen: auto-renew's first, else a plan's. */
  shown: string | null;
  /** An active plan, which keeps its card. */
  blocking: null | { plan_id: string };
};

const isSim = (v: unknown) => String(v ?? '').startsWith('sim_');
const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))];

export async function cardState(sb: Db, tenantId: string, householdId: string): Promise<CardState> {
  const [{ data: hh }, { data: plans }] = await Promise.all([
    sb.from('households').select('id, auto_renew_customer_id, auto_renew_pm_id').eq('id', householdId).eq('tenant_id', tenantId).maybeSingle(),
    sb.from('payment_plans').select('id, status, stripe_customer_id, stripe_payment_method_id').eq('household_id', householdId).eq('tenant_id', tenantId),
  ]);
  const ps = (plans ?? []) as Array<Record<string, unknown>>;
  const active = ps.find(p => p.status === 'active');
  const pms = uniq([hh?.auto_renew_pm_id as string, ...ps.map(p => p.stripe_payment_method_id as string)]);
  const customers = uniq([hh?.auto_renew_customer_id as string, ...ps.map(p => p.stripe_customer_id as string)]).filter(c => !isSim(c));
  return {
    pms, customers,
    shown: (hh?.auto_renew_pm_id as string | null) ?? (active?.stripe_payment_method_id as string | null) ?? pms[0] ?? null,
    blocking: active ? { plan_id: String(active.id) } : null,
  };
}

/** "Visa ending 4242", as Stripe has it. */
export async function cardLabel(stripe: StripeCall | null, pm: string | null): Promise<string | null> {
  if (!pm) return null;
  if (isSim(pm)) return 'Test card';
  if (!stripe) return 'A saved card';
  try {
    const r = await stripe(`payment_methods/${encodeURIComponent(pm)}`);
    const c = r.ok ? r.data?.card : null;
    if (!c?.last4) return 'A saved card';
    const brand = String(c.brand ?? 'card');
    const name = brand === 'amex' ? 'American Express' : brand.charAt(0).toUpperCase() + brand.slice(1);
    return `${name} ending ${c.last4}`;
  } catch { return 'A saved card'; }
}

// Stripe saying it no longer has the card or customer counts as removed.
const gone = (r: { ok: boolean; status: number; data: any }) =>
  r.status === 404 || r.data?.error?.code === 'resource_missing' || /not attached/i.test(String(r.data?.error?.message ?? ''));

export async function removeCards(sb: Db, args: {
  tenantId: string; householdId: string; memberId: string | null; stripe: StripeCall | null; now?: string;
}): Promise<{ ok: true; removed: number } | { ok: false; code: 'none' | 'on_plan' | 'stripe'; error: string }> {
  const st = await cardState(sb, args.tenantId, args.householdId);
  if (st.blocking) return { ok: false, code: 'on_plan', error: PLAN_KEEPS_CARD };
  if (!st.pms.length) return { ok: false, code: 'none', error: 'There\'s no saved card.' };

  // At Stripe first: every card on their customers, and the ones we know of.
  const real = st.pms.filter(p => !isSim(p));
  if ((real.length || st.customers.length) && !args.stripe) {
    return { ok: false, code: 'stripe', error: 'Removing a card isn\'t available right now. Try again later.' };
  }
  const toDetach = new Set(real);
  for (const c of st.customers) {
    const r = await args.stripe!(`customers/${encodeURIComponent(c)}/payment_methods?type=card&limit=100`);
    if (r.ok) for (const pm of (r.data?.data ?? []) as Array<{ id: string }>) toDetach.add(pm.id);
    else if (!gone(r)) return { ok: false, code: 'stripe', error: 'Stripe didn\'t answer. Your card is still saved; try again in a minute.' };
  }
  for (const pm of toDetach) {
    const r = await args.stripe!(`payment_methods/${encodeURIComponent(pm)}/detach`, 'POST');
    if (!r.ok && !gone(r)) return { ok: false, code: 'stripe', error: 'Stripe didn\'t answer. Your card is still saved; try again in a minute.' };
  }

  // Then here: nothing left to charge, auto-renew off, its consent kept as revoked.
  const now = args.now ?? new Date().toISOString();
  await sb.from('households').update({ auto_renew: false, auto_renew_set_at: null, auto_renew_pm_id: null })
    .eq('id', args.householdId).eq('tenant_id', args.tenantId);
  await sb.from('payment_plans').update({ stripe_payment_method_id: null })
    .eq('household_id', args.householdId).eq('tenant_id', args.tenantId);
  await sb.from('payment_authorizations').update({ revoked_at: now, revoked_by: args.memberId })
    .eq('household_id', args.householdId).eq('kind', 'auto_renew').is('revoked_at', null);
  const n = Math.max(toDetach.size, st.pms.length);
  await sb.from('audit_log').insert({
    tenant_id: args.tenantId, kind: 'card.removed', entity_type: 'household', entity_id: args.householdId,
    summary: `The family removed their saved card${n > 1 ? ` (${n} cards)` : ''}; automatic renewal is off`,
    actor_kind: 'member', actor_id: args.memberId, actor_label: 'member',
  });
  return { ok: true, removed: n };
}

// =============================================================================
// poolside_plans.ts — the plans a club pays Poolside for (PLAN.md BL1b)
// =============================================================================
// Three yearly plans. The prices must match Plan & billing (TIERS in
// club/admin/billing.html), pricing.html and home.html;
// scripts/test_stripe_preflight.mjs checks all four.
//
// Each plan is a fixed Stripe product (`poolside_plan_<key>`), made on first
// use, and each checkout carries its price, so nothing has to be set up by
// hand in Stripe, in test mode or live. A club with no plan pays through
// Stripe checkout; a club already on one has that same subscription switched
// (the difference for the rest of the year charged at once going up, a credit
// for its next renewal going down), never a second subscription.
// =============================================================================

export const PLAN_KEYS = ['starter', 'pro', 'enterprise'] as const;
export type PlanKey = typeof PLAN_KEYS[number];
export const PLAN_PRICES_USD: Record<PlanKey, number> = { starter: 900, pro: 2400, enterprise: 4200 };
const PLAN_NAMES: Record<PlanKey, string> = { starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise' };
const PLAN_REACH: Record<PlanKey, string> = { starter: 'Up to 75 households', pro: 'Up to 200 households', enterprise: 'Unlimited households' };

export const isPlanKey = (v: unknown): v is PlanKey => typeof v === 'string' && (PLAN_KEYS as readonly string[]).includes(v);
export const productId = (k: PlanKey) => `poolside_plan_${k}`;
export function planFromProduct(id: unknown): PlanKey | null {
  const m = typeof id === 'string' ? id.match(/^poolside_plan_([a-z]+)$/) : null;
  return m && isPlanKey(m[1]) ? m[1] : null;
}

// deno-lint-ignore no-explicit-any
type Obj = Record<string, any>;
/** The plan a subscription is for: its own note first, else its product. */
export function planFromSubscription(sub: Obj | null | undefined): PlanKey | null {
  if (!sub) return null;
  if (isPlanKey(sub.metadata?.new_plan)) return sub.metadata.new_plan;
  const product = sub.items?.data?.[0]?.price?.product;
  return planFromProduct(typeof product === 'object' && product ? product.id : product);
}

export type StripeResult = { ok: boolean; status?: number; data?: Obj; error?: string };
export type Stripe = (path: string, params?: Record<string, string> | null, method?: 'GET' | 'POST' | 'DELETE') => Promise<StripeResult>;

/** Calls to Poolside's own Stripe account. */
export function stripeCaller(key: string): Stripe {
  return async (path, params = null, method = params ? 'POST' : 'GET') => {
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(params ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
      body: params ? new URLSearchParams(params).toString() : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return res.ok ? { ok: true, status: res.status, data } : { ok: false, status: res.status, data, error: data?.error?.message || `Stripe ${res.status}` };
  };
}

async function ensurePlanProduct(stripe: Stripe, k: PlanKey): Promise<StripeResult> {
  const got = await stripe(`products/${productId(k)}`);
  if (got.ok) return got;
  if (got.status !== 404) return got;
  const made = await stripe('products', { id: productId(k), name: `Poolside ${PLAN_NAMES[k]} plan`, description: PLAN_REACH[k] });
  // Two clubs at once: the other one made it.
  return made.ok ? made : await stripe(`products/${productId(k)}`);
}

/** Put a club on `newPlan`: a checkout link, or its subscription switched. */
export async function changePlan(stripe: Stripe, a: { tenantId: string; newPlan: string; customerId: string | null; clubUrl: string }):
  Promise<{ ok: boolean; url?: string; switched?: boolean; plan?: PlanKey; error?: string }> {
  if (!isPlanKey(a.newPlan)) return { ok: false, error: 'Pick Starter, Pro or Enterprise.' };
  const k = a.newPlan;
  const prod = await ensurePlanProduct(stripe, k);
  if (!prod.ok) return { ok: false, error: prod.error };
  const price = (p: string) => ({
    [`${p}[price_data][product]`]: productId(k),
    [`${p}[price_data][unit_amount]`]: String(PLAN_PRICES_USD[k] * 100),
    [`${p}[price_data][currency]`]: 'usd',
    [`${p}[price_data][recurring][interval]`]: 'year',
  });

  if (a.customerId) {
    const list = await stripe(`subscriptions?customer=${encodeURIComponent(a.customerId)}&status=all&limit=20`);
    if (!list.ok) return { ok: false, error: list.error };
    const sub = (list.data?.data as Obj[] | undefined ?? []).find(s => ['active', 'trialing', 'past_due'].includes(s.status)
      && (planFromSubscription(s) || s.metadata?.tenant_id === a.tenantId));
    if (sub) {
      const item = sub.items?.data?.[0];
      if (!item?.id) return { ok: false, error: 'Stripe has no plan on that subscription. Email support@poolsideapp.com.' };
      const r = await stripe(`subscriptions/${sub.id}`, {
        'items[0][id]': item.id, ...price('items[0]'),
        // Charge (or credit) the difference now; if the card fails, nothing changes.
        proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete',
        'metadata[tenant_id]': a.tenantId, 'metadata[new_plan]': k,
      });
      return r.ok ? { ok: true, switched: true, plan: k } : { ok: false, error: r.error };
    }
  }

  const s = await stripe('checkout/sessions', {
    mode: 'subscription',
    'payment_method_types[0]': 'card',
    ...price('line_items[0]'),
    'line_items[0][quantity]': '1',
    success_url: `${a.clubUrl}/club/admin/billing.html?upgraded=1`,
    cancel_url: `${a.clubUrl}/club/admin/billing.html?upgraded=0`,
    client_reference_id: `plan_upgrade:${a.tenantId}:${k}`,
    'metadata[tenant_id]': a.tenantId, 'metadata[new_plan]': k, 'metadata[kind]': 'plan_upgrade',
    'subscription_data[metadata][tenant_id]': a.tenantId, 'subscription_data[metadata][new_plan]': k,
    ...(a.customerId ? { customer: a.customerId } : {}),
  });
  return s.ok ? { ok: true, url: s.data?.url, plan: k } : { ok: false, error: s.error };
}

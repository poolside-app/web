// =============================================================================
// checkout_close.ts — money for a signup that's gone (PLAN.md BY2, BY3)
// =============================================================================
// Doug 11/6, on the review: "yes do your idea forpayment for deleted signup".
// Before an unpaid signup is deleted or set aside, its open Stripe page is
// closed (Stripe's expire), so it can't be paid any more. Stripe answers one
// way or the other: the page closes, or it was paid already. A payment that
// lands anyway (Stripe couldn't be reached, a page from before this) gives
// the Treasurer a to-do; never an automatic refund (Doug 10/20: the board
// decides what to undo).
// applications, stripe_checkout, purge_household and stripe_webhook use these;
// tested offline by scripts/test_orphan_payments.mjs.
// =============================================================================

import { fmtPoolDate } from './pool_time.ts';

// deno-lint-ignore no-explicit-any
type Sb = any;
/** 'paid': Stripe took the money; 'unknown': Stripe couldn't say. */
export type CloseResult = 'closed' | 'paid' | 'unknown';
type Opts = { key?: string; fetchFn?: typeof fetch };

/** Close one Stripe Checkout page on the club's account. */
export async function closeSession(sessionId: string, opts: Opts & { account: string | null }): Promise<CloseResult> {
  if (!sessionId.startsWith('cs_')) return 'closed';     // a test payment (sim_, free_) never reached Stripe
  if (!opts.key) return 'unknown';
  const f = opts.fetchFn ?? fetch;
  const url = `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${opts.key}`, ...(opts.account ? { 'Stripe-Account': opts.account } : {}) };
  try {
    const r = await f(`${url}/expire`, { method: 'POST', headers });
    if (r.ok) return 'closed';
    // Not open any more: paid, or closed already.
    const g = await f(url, { headers });
    // One Stripe doesn't know on this account (a page from an old or test account) can't be paid here.
    if (!g.ok) return g.status === 404 ? 'closed' : 'unknown';
    const cs = await g.json();
    if (cs.status === 'complete' || cs.payment_status === 'paid') return 'paid';
    return cs.status === 'expired' ? 'closed' : 'unknown';
  } catch { return 'unknown'; }
}

/** Every Stripe page a signup may still have open: its own, and its plans' first payment. */
async function signupSessions(sb: Sb, applicationId: string): Promise<string[]> {
  const out = new Set<string>();
  const { data: app } = await sb.from('applications').select('stripe_session_id').eq('id', applicationId).maybeSingle();
  if (app?.stripe_session_id) out.add(String(app.stripe_session_id));
  const { data: plans } = await sb.from('payment_plans').select('id').eq('application_id', applicationId);
  const ids = (plans ?? []).map((p: { id: string }) => p.id);
  if (ids.length) {
    const { data: firsts } = await sb.from('payment_plan_installments').select('stripe_session_id').in('plan_id', ids).eq('sequence', 1);
    for (const i of firsts ?? []) if (i.stripe_session_id) out.add(String(i.stripe_session_id));
  }
  return [...out].filter(s => s.startsWith('cs_'));
}

/** Close every page a signup has open: 'paid' if any was paid, 'unknown' if Stripe couldn't say. */
export async function closeSignupCheckout(sb: Sb, tenantId: string, applicationId: string, opts: Opts = {}): Promise<CloseResult> {
  const sessions = await signupSessions(sb, applicationId);
  if (!sessions.length) return 'closed';
  const { data: t } = await sb.from('tenants').select('stripe_account_id').eq('id', tenantId).maybeSingle();
  const key = opts.key ?? Deno.env.get('STRIPE_SECRET_KEY');
  let out: CloseResult = 'closed';
  for (const s of sessions) {
    const r = await closeSession(s, { key, account: (t?.stripe_account_id as string) ?? null, fetchFn: opts.fetchFn });
    if (r === 'paid') return 'paid';
    if (r === 'unknown') out = 'unknown';
  }
  return out;
}

/** The Treasurer's to-do for a card payment whose signup was deleted or closed (BY3). */
export function orphanPaymentTask(a: {
  tenantId: string; tz: string; why: 'deleted' | 'closed'; name?: string | null; email?: string | null;
  amountCents: number; paidAt: string; paymentIntent?: string | null; sessionId?: string | null;
}) {
  const usd = `$${(a.amountCents / 100).toFixed(2)}`;
  const who = a.name && a.email ? `${a.name} (${a.email})` : a.name || a.email || 'Someone';
  const day = fmtPoolDate(a.paidAt, a.tz, { month: 'short', day: 'numeric' });
  return {
    tenant_id: a.tenantId, target_scopes: ['payments'], kind: 'payment.no_signup',
    summary: `${who} paid ${usd} by card on ${day} for a signup that was ${a.why}. Refund it in Stripe, or ask them to sign up again.`,
    link_url: '/club/admin/payments.html',
    metadata: { payment_intent: a.paymentIntent ?? null, stripe_session_id: a.sessionId ?? null, amount_cents: a.amountCents, email: a.email ?? null, name: a.name ?? null },
    push_title: '💳 Paid, no signup', push_body: `${who} paid ${usd} for a signup that was ${a.why}.`,
  };
}

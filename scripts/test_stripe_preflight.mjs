#!/usr/bin/env node
// Targeted check for the pre-flight before the payment tests (PLAN.md BL,
// Doug 10/22: "go fix these and check them").
//   BL1  Poolside's own sales (text packs, Premium Setup, plans) reach the
//        webhook: it takes either of two signing secrets, club accounts' and
//        Poolside's own.
//   BL1b Self-serve plans: the prices in one place that agree with the pages,
//        a fixed Stripe product per plan, and a club already on a plan
//        switches that subscription instead of starting a second one.
//   BL1c Every checkout Poolside makes is card only.
// Offline. `--stripe` also runs the plan switch against Stripe's TEST mode
// with throwaway objects it removes (no Supabase calls; refuses a live key).
//
// Usage: node scripts/test_stripe_preflight.mjs [--stripe]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const has = rel => existsSync(new URL(rel, root));
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const shared = rel => new URL(`supabase/functions/_shared/${rel}`, root);

// ── BL1 ──────────────────────────────────────────────────────────────────
console.log('BL1 · the webhook takes club accounts\' and Poolside\'s own payments');
check('the signature check is shared (_shared/stripe_sig.ts)', has('supabase/functions/_shared/stripe_sig.ts'));
if (has('supabase/functions/_shared/stripe_sig.ts')) {
  const { verifyAny, verifyStripeSignature } = await importTs(shared('stripe_sig.ts'));
  const now = 1_800_000_000;
  const sign = (body, secret, t = now, extra = '') => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}${extra}`;
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const A = 'whsec_club', B = 'whsec_platform';
  check('signed with the club accounts\' secret: accepted', await verifyAny(body, sign(body, A), [A, B], 300, now));
  check('signed with Poolside\'s own secret: accepted', await verifyAny(body, sign(body, B), [A, B], 300, now));
  check('signed with anything else: refused', !(await verifyAny(body, sign(body, 'whsec_other'), [A, B], 300, now)));
  check('a changed body: refused', !(await verifyAny(body.replace('evt_1', 'evt_2'), sign(body, A), [A, B], 300, now)));
  check('an old signature (over 5 minutes): refused', !(await verifyAny(body, sign(body, A, now - 301), [A, B], 300, now)));
  check('only one secret set yet: still works', await verifyAny(body, sign(body, A), [A, undefined], 300, now));
  check('Stripe rolling a secret (two v1 signatures): either matches', await verifyStripeSignature(body, sign(body, A) + `,v1=${'0'.repeat(64)}`, A, 300, now)
    && await verifyStripeSignature(body, `t=${now},v1=${'0'.repeat(64)},` + sign(body, A).split(',')[1], A, 300, now));
}
const hook = read('supabase/functions/stripe_webhook/index.ts');
check('stripe_webhook reads both secrets and checks with verifyAny', /STRIPE_WEBHOOK_SECRET_PLATFORM/.test(hook) && /verifyAny\(/.test(hook) && /from '\.\.\/_shared\/stripe_sig\.ts'/.test(hook));
check('  and no longer has its own copy', !/async function verifyStripeSignature/.test(hook));
const billing = read('club/admin/billing.html');
check('Plan & billing says what happened after buying texts', /params\.get\('texts'\) === '1'/.test(billing));

// ── BL1b ─────────────────────────────────────────────────────────────────
console.log('BL1b · self-serve plans');
check('the plans and their prices are in _shared/poolside_plans.ts', has('supabase/functions/_shared/poolside_plans.ts'));
if (has('supabase/functions/_shared/poolside_plans.ts')) {
  const P = await importTs(shared('poolside_plans.ts'));
  const want = { starter: 900, pro: 2400, enterprise: 4200 };
  check('Starter $900, Pro $2,400, Enterprise $4,200 a year', JSON.stringify(P.PLAN_PRICES_USD) === JSON.stringify(want), JSON.stringify(P.PLAN_PRICES_USD));
  const price = (src, name) => { const i = src.indexOf(`>${name}<`); const m = i < 0 ? null : src.slice(i, i + 400).match(/\$([\d,]+)/); return m ? Number(m[1].replace(/,/g, '')) : null; };
  for (const [f, label] of [['pricing.html', 'pricing.html'], ['home.html', 'home.html']]) {
    const src = read(f);
    const got = { starter: price(src, 'Starter'), pro: price(src, 'Pro'), enterprise: price(src, 'Enterprise') };
    check(`  ${label} agrees`, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }
  const tiers = Object.fromEntries([...billing.matchAll(/key: '(starter|pro|enterprise)',[^\n]*?price: (\d+)/g)].map(m => [m[1], Number(m[2])]));
  check('  Plan & billing agrees', JSON.stringify(tiers) === JSON.stringify(want), JSON.stringify(tiers));
  check('one fixed Stripe product per plan', P.productId('pro') === 'poolside_plan_pro' && P.planFromProduct('poolside_plan_enterprise') === 'enterprise' && P.planFromProduct('prod_x') === null);
  check('the plan read off a subscription: its own note first, else its product', P.planFromSubscription({ metadata: { new_plan: 'pro' } }) === 'pro'
    && P.planFromSubscription({ metadata: {}, items: { data: [{ price: { product: 'poolside_plan_starter' } }] } }) === 'starter'
    && P.planFromSubscription({ metadata: {}, items: { data: [{ price: { product: { id: 'poolside_plan_enterprise' } } }] } }) === 'enterprise'
    && P.planFromSubscription({ metadata: { new_plan: 'gold' }, items: { data: [{ price: { product: 'prod_x' } }] } }) === null);

  // A Stripe stand-in that records every call.
  const fake = ({ subs = [], product = true } = {}) => {
    const calls = [];
    const stripe = async (path, params = null, method = params ? 'POST' : 'GET') => {
      calls.push({ path, params, method });
      if (path.startsWith('products/')) return product ? { ok: true, data: { id: path.split('/')[1] } } : { ok: false, status: 404, error: 'No such product' };
      if (path === 'products') return { ok: true, data: { id: params.id } };
      if (path.startsWith('subscriptions?')) return { ok: true, data: { data: subs } };
      if (path.startsWith('subscriptions/')) return { ok: true, data: { id: path.split('/')[1], status: 'active', metadata: { new_plan: params['metadata[new_plan]'] } } };
      if (path === 'checkout/sessions') return { ok: true, data: { id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' } };
      return { ok: false, error: 'unexpected ' + path };
    };
    return { stripe, calls };
  };
  const args = { tenantId: 't1', newPlan: 'pro', clubUrl: 'https://club.poolsideapp.com' };
  {
    const { stripe, calls } = fake({ product: false });
    const r = await P.changePlan(stripe, { ...args, customerId: null });
    const made = calls.find(c => c.path === 'products');
    const cs = calls.find(c => c.path === 'checkout/sessions')?.params || {};
    check('a club with no plan: the product is made once if missing', made?.params?.id === 'poolside_plan_pro', JSON.stringify(made));
    check('  then Stripe checkout: a yearly $2,400 subscription, card only', r.ok && r.url && cs.mode === 'subscription' && cs['line_items[0][price_data][product]'] === 'poolside_plan_pro'
      && cs['line_items[0][price_data][unit_amount]'] === '240000' && cs['line_items[0][price_data][recurring][interval]'] === 'year' && cs['payment_method_types[0]'] === 'card'
      && cs['subscription_data[metadata][new_plan]'] === 'pro' && cs['metadata[kind]'] === 'plan_upgrade', JSON.stringify(cs).slice(0, 300));
  }
  {
    const sub = { id: 'sub_1', status: 'active', metadata: { tenant_id: 't1', new_plan: 'starter' }, items: { data: [{ id: 'si_1', price: { product: 'poolside_plan_starter' } }] } };
    const { stripe, calls } = fake({ subs: [sub] });
    const r = await P.changePlan(stripe, { ...args, customerId: 'cus_1' });
    const up = calls.find(c => c.path === 'subscriptions/sub_1')?.params || {};
    check('a club already on a plan: that subscription is switched, no second checkout', r.ok && r.switched && !calls.some(c => c.path === 'checkout/sessions'), JSON.stringify(r));
    check('  same subscription item, the new yearly price, the difference charged now, the plan noted', up['items[0][id]'] === 'si_1' && up['items[0][price_data][product]'] === 'poolside_plan_pro'
      && up['items[0][price_data][unit_amount]'] === '240000' && up['items[0][price_data][recurring][interval]'] === 'year' && up.proration_behavior === 'always_invoice'
      && up.payment_behavior === 'error_if_incomplete' && up['metadata[new_plan]'] === 'pro', JSON.stringify(up).slice(0, 300));
  }
  {
    const { stripe } = fake();
    check('an unknown plan is refused', !(await P.changePlan(stripe, { ...args, newPlan: 'gold', customerId: null })).ok);
  }
}
const admin = read('supabase/functions/tenant_admin_auth/index.ts');
const upgrade = admin.slice(admin.indexOf("action === 'start_plan_upgrade'"), admin.indexOf("Unknown action"));
check('start_plan_upgrade uses changePlan, no price IDs to set up', /changePlan\(/.test(upgrade) && !/STRIPE_PRICE_/.test(upgrade));
check('no club is pointed at hello@ any more', !/hello@poolsideapp\.com/.test(admin) && !/hello@poolsideapp\.com/.test(billing));
check('Plan & billing: "Switch to" for a lower plan, and a plan switched in place shows', /Switch to/.test(billing) && /d\.switched/.test(billing));
check('the webhook reads the plan off the subscription, and only while it\'s live', /planFromSubscription\(/.test(hook) && /'active'/.test(hook) && /'trialing'/.test(hook));

// ── BL1c ─────────────────────────────────────────────────────────────────
console.log('BL1c · every checkout is card only');
const fnDir = new URL('supabase/functions/', root);
const files = readdirSync(fnDir, { withFileTypes: true }).flatMap(d => d.isDirectory()
  ? (d.name === '_shared' ? readdirSync(new URL(`${d.name}/`, fnDir)).filter(f => f.endsWith('.ts')).map(f => `supabase/functions/_shared/${f}`)
    : (has(`supabase/functions/${d.name}/index.ts`) ? [`supabase/functions/${d.name}/index.ts`] : [])) : []);
let sessions = 0;
const missing = [];
for (const f of files) {
  const src = read(f);
  if (!/checkout\/sessions/.test(src)) continue;
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (!/(append\('mode',\s*'(payment|setup|subscription)'\)|\bmode:\s*'(payment|setup|subscription)')/.test(l)) return;
    sessions++;
    // From the mode to where that checkout is sent (or its branch ends).
    let end = i + 1;
    while (end < lines.length && end < i + 60 && !/checkout\/sessions|\} else \{/.test(lines[end])) end++;
    const block = lines.slice(i, end + 1).join('\n');
    if (!/payment_method_types\[0\]['"]?\s*[,:]\s*'card'/.test(block)) missing.push(`${f}:${i + 1}`);
  });
}
check(`every checkout Poolside makes says card (${sessions} found)`, sessions >= 10 && missing.length === 0, missing.join(', '));

// ── BL2 ──────────────────────────────────────────────────────────────────
console.log('BL2 · a card kept for later belongs to a Stripe customer');
// Stripe only makes a customer at checkout when told to ("if_required" makes
// none for a one-off payment), and a card with no customer can't be charged
// again: next season's auto-renew would find nothing to charge.
const orphans = [];
let kept = 0;
for (const f of files) {
  const src = read(f);
  if (!/checkout\/sessions/.test(src)) continue;
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (!/setup_future_usage/.test(l)) return;
    kept++;
    const block = lines.slice(Math.max(0, i - 25), i + 25).join('\n');
    const customer = /customer_creation['"]?\s*[,:]\s*'always'/.test(block) || /append\('customer',|['"]customer['"]\s*:/.test(block);
    if (!customer) orphans.push(`${f}:${i + 1}`);
  });
}
check(`every checkout that keeps a card makes or names a customer (${kept} found)`, kept >= 3 && orphans.length === 0, orphans.join(', '));

console.log('BL2 · connecting Stripe comes back to Money → Payments');
const connect = read('supabase/functions/stripe_connect/index.ts');
const pay = read('club/admin/payments.html');
check('after Stripe\'s sign-up, back to Payments (where Connect Stripe is), which refreshes the status', /club\/admin\/payments\.html#stripe=connected/.test(connect) && !/settings\.html#stripe=/.test(connect)
  && /stripe=connected/.test(pay));
check('  an expired Stripe link starts a fresh one', /club\/admin\/payments\.html#stripe=retry/.test(connect) && /hash\.includes\('stripe=retry'\)[\s\S]{0,300}connectStripe\(\)/.test(pay));
check('  the note names the button that\'s there ("Resume onboarding")', !/Click <b>Resume setup<\/b>/.test(pay) && /Click <b>Resume onboarding<\/b>/.test(pay));

// ── BL1b against Stripe's test mode ─────────────────────────────────────
if (process.argv.includes('--stripe')) {
  console.log('BL1b · the plan switch against Stripe\'s TEST mode (throwaway objects, removed after)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  const key = env.STRIPE_SECRET_KEY || '';
  if (!key.startsWith('sk_test_')) { console.log('  refusing: not a test key'); process.exit(1); }
  const P = await importTs(shared('poolside_plans.ts'));
  const stripe = P.stripeCaller(key);
  let cus = null, sub = null;
  try {
    cus = (await stripe('customers', { name: 'Poolside pre-flight (test, delete me)', payment_method: 'pm_card_visa', 'invoice_settings[default_payment_method]': 'pm_card_visa' })).data;
    const first = await P.changePlan(stripe, { tenantId: 'preflight', newPlan: 'starter', customerId: cus.id, clubUrl: 'https://example.com' });
    check('no plan yet: Stripe takes the checkout (card only, yearly price on the product)', first.ok && /^https:\/\/checkout\.stripe\.com/.test(first.url || ''), first.error);
    // Stand in for the club paying: a subscription on the same product and price shape.
    const s = await stripe('subscriptions', { customer: cus.id, 'items[0][price_data][product]': P.productId('starter'), 'items[0][price_data][unit_amount]': '90000',
      'items[0][price_data][currency]': 'usd', 'items[0][price_data][recurring][interval]': 'year', 'metadata[tenant_id]': 'preflight', 'metadata[new_plan]': 'starter' });
    sub = s.data;
    check('  (stand-in: on Starter, $900 paid)', s.ok && sub.status === 'active', s.error);
    const up = await P.changePlan(stripe, { tenantId: 'preflight', newPlan: 'pro', customerId: cus.id, clubUrl: 'https://example.com' });
    const after = (await stripe(`subscriptions/${sub.id}`)).data;
    const subs = (await stripe(`subscriptions?customer=${cus.id}&status=all`)).data.data;
    const inv = (await stripe(`invoices?customer=${cus.id}&limit=5`)).data.data;
    check('Starter → Pro: the same subscription, now $2,400 a year', up.ok && up.switched && after.items.data[0].price.unit_amount === 240000 && subs.length === 1 && P.planFromSubscription(after) === 'pro', up.error || JSON.stringify(subs.map(x => x.status)));
    check('  the difference for the rest of the year charged at once', inv.some(i => i.amount_paid > 0 && i.amount_paid < 240000 && i.billing_reason === 'subscription_update'), JSON.stringify(inv.map(i => [i.billing_reason, i.amount_paid])));
    const down = await P.changePlan(stripe, { tenantId: 'preflight', newPlan: 'starter', customerId: cus.id, clubUrl: 'https://example.com' });
    const bal = (await stripe(`customers/${cus.id}`)).data.balance;
    check('Pro → Starter: switched back, a credit left for the next renewal', down.ok && down.switched && bal < 0, `${down.error || ''} balance ${bal}`);
  } finally {
    if (sub) await stripe(`subscriptions/${sub.id}`, null, 'DELETE');
    if (cus) await stripe(`customers/${cus.id}`, null, 'DELETE');
    console.log('  (throwaway test customer and subscription removed)');
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

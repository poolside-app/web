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
//   BN1b Connect a different Stripe account (PLAN.md BN1), and a saved account
//        Stripe doesn't know (a test-mode one once the live key is in) is set
//        aside for a fresh one.
// Offline. `--stripe` also runs the plan switch against Stripe's TEST mode
// with throwaway objects it removes (no Supabase calls; refuses a live key).
// `--live` runs BN1b on a throwaway club in Stripe's test mode (about 6 calls).
//
// Usage: node scripts/test_stripe_preflight.mjs [--stripe] [--live]
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

// ── BL3 ──────────────────────────────────────────────────────────────────
console.log('BL3 · test runs never email or text made-up addresses');
// The live tests use example.com emails and 555 numbers. Mail to example.com
// bounces, and bounces count against Poolside's sending reputation, which
// every club's receipts and sign-in emails depend on.
check('a shared check for addresses no real person has (_shared/test_recipients.ts)', has('supabase/functions/_shared/test_recipients.ts'));
if (has('supabase/functions/_shared/test_recipients.ts')) {
  const { isTestRecipient } = await importTs(shared('test_recipients.ts'));
  const test = ['pat@example.com', 'a@EXAMPLE.org', 'x@mail.example.net', 'b@club.test', 'c@nowhere.invalid', 'd@localhost', '+15551234560001', '+1 (555) 123-4567'];
  const real = ['doug.frevele+simtest@gmail.com', 'treasurer@bishopestates.org', 'me@examples.com', 'me@testing.com', '+19255551234', '+14155550100', ''];
  check('  example.com/.org/.net, .test, .invalid, localhost and the 555 area code are test addresses', test.every(isTestRecipient), test.filter(x => !isTestRecipient(x)).join(', '));
  check('  real-looking addresses are not (a 555 exchange in a real area code is real)', real.every(x => !isTestRecipient(x)), real.filter(isTestRecipient).join(', '));
}
const sendsUnguarded = [];
let sendPoints = 0;
for (const f of files) {
  if (/smoke_sms/.test(f)) continue;   // its whole job is one real text to Doug
  const lines = read(f).split('\n');
  lines.forEach((l, i) => {
    if (!/fetch\([^)]*api\.(resend\.com|twilio\.com)/.test(l)) return;
    sendPoints++;
    // Back to the start of the function (or the nearest guard) this send is in.
    let j = i;
    while (j > 0 && i - j < 80 && !/^(export )?async function |^\s*if \(canEmail/.test(lines[j])) j--;
    if (!/isTest(Recipient|Email|Phone)\(/.test(lines.slice(j, i).join('\n'))) sendsUnguarded.push(`${f}:${i + 1}`);
  });
}
check(`every email and text Poolside sends skips test addresses first (${sendPoints} found)`, sendPoints >= 10 && sendsUnguarded.length === 0, sendsUnguarded.join(', '));

// ── BN1b ─────────────────────────────────────────────────────────────────
console.log('BN1b · connect a different Stripe account');
{
  let SA = null;
  try { SA = await importTs(shared('stripe_account.ts')); } catch { SA = null; }
  check('_shared/stripe_account.ts exists', !!SA);
  check('Stripe\'s "no such account" (and the other mode\'s) is recognized',
    !!SA && SA.isMissingAccount("No such account: 'acct_1'; a similar object exists in test mode, but a live mode key was used to make this request.")
    && SA.isMissingAccount('No such account: acct_x') && !SA.isMissingAccount('Your card was declined.') && !SA.isMissingAccount(''));
  check('  and the wording Stripe uses when looking an account up (found live)', !!SA
    && SA.isMissingAccount("The provided key 'sk_test_***abcd' does not have access to account 'acct_1NotARealOne000' (or that account does not exist). Application access may have been revoked."));
  check('the refusal counts the families and points to support@',
    !!SA && /2 families have cards saved/.test(SA.switchBlocked(2)) && /1 family has a card saved/.test(SA.switchBlocked(1)) && /support@poolsideapp\.com/.test(SA.switchBlocked(1)), SA && SA.switchBlocked(2));
  const sa = has('supabase/functions/_shared/stripe_account.ts') ? read('supabase/functions/_shared/stripe_account.ts') : '';
  check('saved cards counted: active plans and auto-renew, never test cards',
    /from\('payment_plans'\)[\s\S]{0,200}eq\('status', 'active'\)[\s\S]{0,200}not\('stripe_payment_method_id', 'like', 'sim_%'\)/.test(sa)
    && /from\('households'\)[\s\S]{0,200}eq\('auto_renew', true\)[\s\S]{0,200}not\('auto_renew_pm_id', 'like', 'sim_%'\)/.test(sa));
  const c = read('supabase/functions/stripe_connect/index.ts');
  const sw = c.slice(c.indexOf("action === 'switch_account'"));
  check('stripe_connect has switch_account', /action === 'switch_account'/.test(c));
  check('  owner only', /requireOwner/.test(sw.slice(0, 600)));
  check('  refuses while families have saved cards', /savedCards\(/.test(sw) && /switchBlocked\(/.test(sw) && /409/.test(sw.slice(0, 1500)));
  // PLAN.md CQ (Doug 11/8): a fresh texted code, then a second board member
  // approves; the approval sets the old account aside (_shared/pending_change.ts)
  // and Connect Stripe starts the new one.
  const swOnly = sw.slice(0, sw.indexOf("action === 'sync'"));
  check('  a code, then a second board member approves; the approval sets the old account aside, in the Activity log',
    /purpose: 'stripe_switch'/.test(swOnly) && /requestChange\(/.test(swOnly) && !/forgetAccount\(/.test(swOnly)
    && /stripe\.account_switched/.test(read('supabase/functions/_shared/pending_change.ts')));
  const forget = c.slice(c.indexOf('async function forgetAccount'), c.indexOf('async function forgetAccount') + 900);
  check('  forgetting clears the account and both switches', /stripe_account_id: null/.test(forget) && /stripe_charges_enabled: false/.test(forget) && /stripe_payouts_enabled: false/.test(forget) && /audit_log/.test(forget));
  const onb = c.slice(c.indexOf("action === 'onboard'"), c.indexOf("action === 'sync'"));
  check('Connect Stripe: an account Stripe doesn\'t know is set aside, and a fresh one made', /isMissingAccount\(/.test(c) && /startOnboarding\(/.test(onb));
  const syn = c.slice(c.indexOf("action === 'sync'"));
  check('Refresh status: the same', /isMissingAccount\(/.test(syn) && /forgetAccount\(/.test(syn) && /connected: false/.test(syn));
  check('Money → Payments: the button, owner only, shown once connected', /id="stripe-switch-btn"/.test(pay) && /function switchStripe/.test(pay)
    && /switchBtn\.style\.display = 'inline-block'/.test(pay) && /data-owner-only data-focus="stripe"[\s\S]{0,1400}id="stripe-switch-btn"/.test(pay));
  check('  it asks first, then goes to Stripe', /switchStripe[\s\S]{0,400}confirm\(/.test(pay) && /'switch_account'/.test(pay));
  const art = read('club/admin/help/articles/go-live-card-payments.md');
  check('the help article says how to switch', /\*\*Connect a different Stripe account\*\*/.test(art));
}

// ── BN1b on a throwaway club, Stripe test mode ──────────────────────────
if (process.argv.includes('--live')) {
  console.log('BN1b · live: a throwaway club, Stripe\'s test mode (removed after)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  if (!String(env.STRIPE_SECRET_KEY).startsWith('sk_test_')) { console.log('  refusing: not a test key'); process.exit(1); }
  const { makeTempClub, dropTempClub } = await import('./lib/testdata.mjs');
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-preflight/1.0' }, body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  const q = v => v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = p => { const h = b64({ alg: 'HS256', typ: 'JWT' }), b = b64({ ...p, exp: Math.floor(Date.now() / 1000) + 3600 });
    return `${h}.${b}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`; };
  const stripeGet = async (path, method = 'GET') => (await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } })).json();
  const made = new Set();
  let club = null;
  try {
    club = await makeTempClub(sql, 'stripe');
    const [admin] = await sql(`insert into admin_users (tenant_id, username, email, password_hash, display_name, role_template, scopes, is_default_pw, active)
      values (${q(club.id)}, ${q(`simtest-stripe-${club.stamp}`)}, 'delivered@resend.dev', 'x', 'Owner Tester', 'owner', array[]::text[], false, true) returning id`);
    const tok = jwt({ sub: admin.id, kind: 'tenant_admin', tid: club.id, slug: club.slug, role_template: 'owner' });
    const call = async body => (await fetch(`${env.SUPABASE_URL}/functions/v1/stripe_connect`, { method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) })).json().then(j => j, () => ({}));
    const acctOf = async () => (await sql(`select stripe_account_id, stripe_charges_enabled from tenants where id = ${q(club.id)}`))[0];

    // An account Stripe doesn't have (as a test account looks to the live key).
    await sql(`update tenants set stripe_account_id = 'acct_1NotARealOne000', stripe_charges_enabled = true where id = ${q(club.id)}`);
    const syncR = await call({ action: 'sync' });
    const afterSync = await acctOf();
    check('Refresh status: an account Stripe doesn\'t know is set aside', syncR.ok && syncR.connected === false && !afterSync.stripe_account_id && afterSync.stripe_charges_enabled === false, JSON.stringify({ syncR, afterSync }));
    await sql(`update tenants set stripe_account_id = 'acct_1NotARealOne000', stripe_charges_enabled = true where id = ${q(club.id)}`);
    const onb = await call({ action: 'onboard' });
    const afterOnb = await acctOf();
    if (afterOnb.stripe_account_id) made.add(afterOnb.stripe_account_id);
    check('Connect Stripe: a fresh account and Stripe\'s sign-up page instead of an error', onb.ok && /^https:\/\/connect\.stripe\.com\//.test(onb.url || '')
      && /^acct_/.test(afterOnb.stripe_account_id || '') && afterOnb.stripe_account_id !== 'acct_1NotARealOne000' && afterOnb.stripe_charges_enabled === false, JSON.stringify({ onb, afterOnb }));
    const logged = await sql(`select count(*)::int n from audit_log where tenant_id = ${q(club.id)} and kind = 'stripe.account_switched'`);
    check('  written in the Activity log', logged[0].n >= 1, JSON.stringify(logged));

    // A family with a real card saved on it: the switch is refused.
    const [hh] = await sql(`insert into households (tenant_id, family_name, active) values (${q(club.id)}, 'SimTest Card', true) returning id`);
    await sql(`insert into payment_plans (tenant_id, household_id, plan_type, total_cents, status, stripe_customer_id, stripe_payment_method_id, family_name)
      values (${q(club.id)}, ${q(hh.id)}, 'flex', 60000, 'active', 'cus_x', 'pm_realcard', 'SimTest Card')`);
    const blocked = await call({ action: 'switch_account' });
    check('Switch: refused while a family has a card saved with this account', blocked.ok === false && /1 family has a card saved/.test(blocked.error || '') && (await acctOf()).stripe_account_id === afterOnb.stripe_account_id, JSON.stringify(blocked));
    await sql(`update payment_plans set stripe_payment_method_id = 'sim_pm_test' where tenant_id = ${q(club.id)}`);
    const sw = await call({ action: 'switch_account' });
    const afterSw = await acctOf();
    check('Switch: with only a test card, it asks for a texted code and changes nothing (PLAN.md CQ)', sw.ok === false && sw.needs_code === true
      && afterSw.stripe_account_id === afterOnb.stripe_account_id, JSON.stringify({ sw, afterSw }));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    for (const id of made) { const d = await stripeGet(`/accounts/${id}`, 'DELETE'); check(`cleanup: Stripe test account ${id.slice(0, 9)}… deleted`, d.deleted === true, JSON.stringify(d)); }
    if (club) check('cleanup: the throwaway club is gone', (await dropTempClub(sql, club)) === 0);
  }
}

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

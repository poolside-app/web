// Live part of scripts/test_flex_plan.mjs (PLAN.md M8).
//
// Builds a throwaway club with its own Stripe TEST account (Stripe's published
// test data, no real person or bank), runs Doug's list against it, and deletes
// the club and the Stripe account at the end, pass or fail:
//   start to finish, a declined card, the card updated after a failure, a lapse
//   and reinstating, paying off early, canceling, a late joiner, the rounding,
//   the paid-in-full deadline, and real Stripe checkout pages being made.
//   W: the board's $1 test level, paid weekly (PLAN.md BN1).
//
// Payments made on Stripe's own page are stood in for by the club's test
// payments (the same webhook path); every monthly charge is a real Stripe test
// charge on a saved test card. Emails go to Resend's test inbox and texts to
// the undeliverable 555 exchange. About 50 Edge Function calls.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
// A signed payment plan agreement (PLAN.md CL2): checkout won't start a plan without one.
const PLAN_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export async function runLive({ check, short }) {
  const root = new URL('../../', import.meta.url);
  const env = Object.fromEntries(readFileSync(new URL('.env.local', root), 'utf8')
    .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
    .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET, STRIPE_SECRET_KEY, CRON_SECRET } = env;
  const ONLY = (process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
  const run = step => !ONLY.length || ONLY.includes(step);
  if (!String(STRIPE_SECRET_KEY).startsWith('sk_test_')) {
    check('live: the Stripe key is a test key', false, 'refusing to run against a live key');
    return false;
  }

  let calls = 0;
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-flex/1.0' },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
    return r.json();
  };
  const q = v => v === null || v === undefined ? 'null' : `'${String(v).replace(/'/g, "''")}'`;
  const b64url = b => Buffer.from(b).toString('base64url');
  const jwt = p => {
    const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const body = b64url(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 3600 }));
    return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
  };
  const fn = async (name, body, opts = {}) => {
    calls++;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}), ...(opts.headers || {}) },
      body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const stripe = async (method, path, params = {}, account = null) => {
    const r = await fetch(`https://api.stripe.com/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
        ...(account ? { 'Stripe-Account': account } : {}),
      },
      body: method === 'GET' ? undefined : new URLSearchParams(params).toString(),
    });
    return r.json();
  };
  const claims = url => {
    const t = new URL(url).hash.replace(/^#t=/, '');
    return { token: t, ...JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) };
  };
  const grossUp = c => Math.ceil((c + 30) / (1 - 0.029));

  const STAMP = Date.now().toString(36).slice(-5);
  const SLUG = `simtest-plans-${STAMP}`;
  let tenantId = null, acct = null;
  const plans = {};

  try {
    // ── Setup: a Stripe test account that can take cards ───────────────────
    const a = await stripe('POST', '/accounts', {
      country: 'US', email: `simtest-plans-${STAMP}@example.com`, business_type: 'individual',
      'controller[fees][payer]': 'application', 'controller[losses][payments]': 'application',
      'controller[stripe_dashboard][type]': 'none', 'controller[requirement_collection]': 'application',
      'capabilities[card_payments][requested]': 'true', 'capabilities[transfers][requested]': 'true',
      'business_profile[mcc]': '7997', 'business_profile[url]': 'https://poolsideapp.com',
      'business_profile[product_description]': 'Throwaway pool club for payment plan tests',
      'individual[first_name]': 'Plan', 'individual[last_name]': 'Tester',
      'individual[email]': `simtest-plans-${STAMP}@example.com`, 'individual[phone]': '0000000000',
      'individual[dob][day]': '1', 'individual[dob][month]': '1', 'individual[dob][year]': '1901',
      'individual[address][line1]': 'address_full_match', 'individual[address][city]': 'Concord',
      'individual[address][state]': 'CA', 'individual[address][postal_code]': '94518',
      'individual[ssn_last_4]': '0000',
      'tos_acceptance[date]': String(Math.floor(Date.now() / 1000)), 'tos_acceptance[ip]': '127.0.0.1',
      external_account: 'btok_us_verified',
    });
    if (a.error) { check('setup: Stripe test account', false, a.error.message); return false; }
    acct = a.id;
    let ready = a.charges_enabled;
    // Stripe verifies the test identity in about a minute.
    for (let i = 0; !ready && i < 30; i++) {
      await new Promise(r => setTimeout(r, 5000));
      ready = (await stripe('GET', `/accounts/${acct}`)).charges_enabled;
    }
    if (!check('setup: a Stripe test account that can take cards', ready, acct)) return false;

    // ── Setup: the club, selling the 2027 season ───────────────────────────
    const [t] = await sql(`insert into tenants (slug, display_name, status, plan, timezone, stripe_account_id, stripe_charges_enabled, platform_fees_waived)
      values (${q(SLUG)}, 'SimTest Plan Club', 'active', 'starter', 'America/Los_Angeles', ${q(acct)}, true, false) returning id`);
    tenantId = t.id;
    const planCfg = {
      enabled: true, access_when: 'half_paid', tiers: ['family'], min_installment_cents: 2500, max_installments: 12,
      reactivation_fee_cents: 5000, auto_deactivate_keyfob: true, reminder_days_before: [], retry_days: [3, 7, 14],
      milestones: [{ date: '04-10', min_pct: 50, label: 'Half paid' }, { date: '07-15', min_pct: 100, label: 'Paid in full' }],
    };
    const settings = (plan) => ({
      membership_tiers: [{ slug: 'family', label: 'Family', price_cents: 60000 }, { slug: 'single', label: 'Single', price_cents: 30000 }],
      membership: { renewal_opens_month: 10 },
      payments: { test_mode: true, pass_stripe_fee: true, plan },
    });
    const setSettings = async (plan, extra = {}) => {
      const v = settings(plan); Object.assign(v.payments, extra);
      await sql(`delete from settings where tenant_id = ${q(tenantId)};
        insert into settings (tenant_id, value) values (${q(tenantId)}, ${q(JSON.stringify(v))}::jsonb)`);
    };
    await setSettings(planCfg);
    const [{ today }] = await sql(`select to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as today`);
    const admin = jwt({ sub: '00000000-0000-0000-0000-000000000000', kind: 'tenant_admin', tid: tenantId, slug: SLUG, role_template: 'owner', is_super: true });
    // Nothing is charged until the board ticks it on Money → Upcoming (PLAN.md
    // S; test_plan_approval checks the ticking). Here every payment due is
    // ticked first, as the Treasurer would, then the daily run goes.
    const cron = async () => {
      await sql(`update payment_plan_installments set approved_at = now()
        where tenant_id = ${q(tenantId)} and status in ('pending', 'retrying') and due_date <= ${q(today)} and approved_at is null`);
      return fn('payment_plans', { action: 'cron_run' }, { headers: { 'x-cron-secret': CRON_SECRET } });
    };

    const phoneBase = String(Date.now()).slice(-6);
    const mkApp = async (n, tier = 'family') => {
      const [app] = await sql(`insert into applications (tenant_id, family_name, primary_name, primary_email, primary_phone,
          membership_year, status, payment_status, tier_slug, is_renewal, is_new_member)
        values (${q(tenantId)}, ${q(`SimTest Plan ${n}`)}, ${q(`Plan Tester ${n}`)}, 'delivered@resend.dev', ${q(`+1555${phoneBase}${n}`)},
          2027, 'pending', 'unpaid', ${q(tier)}, false, true) returning id`);
      return app.id;
    };
    const planOf = async appId => (await sql(`select * from payment_plans where application_id = ${q(appId)}`))[0];
    const rowsOf = async planId => sql(`select * from payment_plan_installments where plan_id = ${q(planId)} order by sequence`);
    const memberTok = async plan => {
      const [m] = await sql(`select id from household_members where household_id = ${q(plan.household_id)} and role = 'primary'`);
      return jwt({ sub: m.id, kind: 'member', tid: tenantId, hid: plan.household_id, slug: SLUG });
    };
    // Start a plan through checkout and the club's test payment page.
    const start = async (n, today_cents, payoff_month) => {
      const appId = await mkApp(n);
      const r = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: appId, today_cents, payoff_month });
      if (!r.ok) return { appId, error: r.error, r };
      const c = claims(r.url);
      const s = await fn('stripe_checkout', { action: 'simulate_complete', token: c.token });
      return { appId, amt: c.amt, kind: c.md.kind, sim: s, plan: await planOf(appId) };
    };
    // A real saved test card on the club's Stripe account.
    const realCard = async (plan, token) => {
      const cus = await stripe('POST', '/customers', { name: plan.family_name }, acct);
      const pm = await stripe('POST', '/payment_methods', { type: 'card', 'card[token]': token }, acct);
      await stripe('POST', `/payment_methods/${pm.id}/attach`, { customer: cus.id }, acct);
      await sql(`update payment_plans set stripe_customer_id = ${q(cus.id)}, stripe_payment_method_id = ${q(pm.id)} where id = ${q(plan.id)}`);
      return { cus: cus.id, pm: pm.id };
    };

    // ── S1: start to finish (Member A's shape), and the rounding ───────────
    if (run('S1')) {
      console.log('M8 · S1 start to finish');
      const quote = await fn('applications', { action: 'quote', slug: SLUG, tier_slug: 'family', plan_today_cents: 10000, plan_payoff_month: '2027-05' });
      const ch = quote.plan?.choice;
      const monthly = (ch?.rows || []).filter(r => !r.today);
      check('S1: the quote shows $100 today, then monthly through May', ch?.ok && ch.rows[0].today && ch.rows[0].amount_cents === 10000
        && monthly.at(-1)?.due_date.startsWith('2027-05'), short(ch));
      const base = monthly[0]?.amount_cents;
      check('S1: equal payments, the last one absorbing the rounding, $600 in all',
        monthly.slice(0, -1).every(r => r.amount_cents === base) && monthly.at(-1).amount_cents >= base
        && ch.totals.dues_cents === 60000, short(monthly.map(r => r.amount_cents)));
      check('S1: the $4 plan fee (capped at $16) and the card fee are on each payment',
        ch.totals.plan_fee_cents === 1600 && ch.rows.every(r => r.charge_cents === grossUp(r.amount_cents + r.plan_fee_cents)), short(ch.totals));

      const s = await start(1, 10000, '2027-05');
      plans.s1 = s.plan;
      check('S1: checkout takes payment 1 (dues + plan fee + card fee)', s.kind === 'payment_plan_first' && s.amt === ch.rows[0].charge_cents, short({ kind: s.kind, amt: s.amt, want: ch.rows[0].charge_cents }));
      const [app] = await sql(`select status, payment_status, payment_method, household_id from applications where id = ${q(s.appId)}`);
      check('S1: the family is approved, on a plan', app.status === 'approved' && app.payment_method === 'stripe_plan' && !!app.household_id, short(app));
      const rows = await rowsOf(s.plan.id);
      check('S1: payment 1 is paid; the rest are scheduled', rows[0].status === 'paid' && rows.slice(1).every(r => r.status === 'pending') && rows.length === ch.rows.length, short(rows.map(r => r.status)));
      check('S1: stored payments add up to exactly $600', rows.reduce((n, r) => n + r.amount_cents, 0) === 60000);
      const [hh] = await sql(`select dues_paid_for_year from households where id = ${q(app.household_id)}`);
      check('S1: no gate yet ($100 of $600 is not half)', hh.dues_paid_for_year === false && !s.plan.access_at, short(hh));

      // Every later payment due today, on a real test card.
      await realCard(s.plan, 'tok_visa');
      await sql(`update payment_plan_installments set due_date = ${q(today)} where plan_id = ${q(s.plan.id)} and status = 'pending'`);
      const c = await cron();
      check('S1: the daily run charges every payment due', c.ok && c.charged >= rows.length - 1, short(c));
      const after = await rowsOf(s.plan.id);
      const p = await planOf(s.appId);
      check('S1: all paid, the plan finished', after.every(r => r.status === 'paid') && p.status === 'completed', short({ st: after.map(r => r.status), plan: p.status }));
      const [hh2] = await sql(`select dues_paid_for_year, paid_until_year from households where id = ${q(app.household_id)}`);
      check('S1: the gate opens, paid through 2027', hh2.dues_paid_for_year === true && hh2.paid_until_year === 2027 && !!p.access_at, short(hh2));
      const tasks = await sql(`select kind, summary from admin_tasks where tenant_id = ${q(tenantId)} and source_id = ${q(p.id)}`);
      // PLAN.md CH: the keyfob to-do only when the family has a keyfob to turn on; this one has none.
      const [{ n: fobsOn }] = await sql(`select count(*)::int as n from keyfobs where household_id = ${q(app.household_id)} and status = 'active' and card_number is not null`);
      check('S1: a keyfob to-do only if they have a keyfob to turn on', fobsOn > 0 || !tasks.some(t => t.kind === 'plan.fob_on'), short(tasks));
      const one = after[1];
      const pi = await stripe('GET', `/payment_intents/${one.stripe_payment_intent_id}`, {}, acct);
      check('S1: Stripe charged dues + plan fee + card fee, off-session',
        pi.status === 'succeeded' && pi.amount === one.amount_cents + one.plan_fee_cents + one.card_fee_cents, short({ amount: pi.amount, status: pi.status }));
      check('S1: Poolside takes 1% of the dues plus the plan fee',
        pi.application_fee_amount === Math.floor(one.amount_cents / 100) + one.plan_fee_cents, short({ fee: pi.application_fee_amount }));
      const again = await cron();
      check('S1: a second run charges nothing twice', again.ok && after.every(r => r.attempt_count <= 1), short(again));
    }

    // ── S2: a declined card, then the card updated ─────────────────────────
    if (run('S2')) {
      console.log('M8 · S2 declined card, card updated');
      const s = await start(2, 0, '2027-05');
      plans.s2 = s.plan;
      check('S2: $0 today only saves the card', s.kind === 'payment_plan_setup' && s.amt === 0 && !!s.plan?.stripe_payment_method_id, short({ kind: s.kind, amt: s.amt }));
      const [app] = await sql(`select status from applications where id = ${q(s.appId)}`);
      check('S2: approved with nothing paid yet', app.status === 'approved');
      await realCard(s.plan, 'tok_chargeCustomerFail');
      const [first] = await rowsOf(s.plan.id);
      await sql(`update payment_plan_installments set due_date = ${q(today)} where id = ${q(first.id)}`);
      await cron();
      const [f1] = await rowsOf(s.plan.id);
      check('S2: the card is declined, to be tried again', f1.status === 'retrying' && f1.attempt_count === 1 && !!f1.first_failed_at && !!f1.last_error, short(f1));
      await cron();
      const [f2] = await rowsOf(s.plan.id);
      check('S2: not retried the same day (next try in 3 days)', f2.attempt_count === 1, short(f2.attempt_count));
      const mt = await memberTok(s.plan);
      const v = await fn('payment_plans', { action: 'member_plan' }, { token: mt });
      check('S2: the family sees it past due', v.ok && v.plan?.status === 'past_due' && v.plan.next?.date === today, short(v.plan));
      const u = await fn('stripe_checkout', { action: 'plan_card' }, { token: mt });
      const uc = u.ok ? claims(u.url) : {};
      check('S2: a new card pays what is overdue right away', u.ok && uc.md?.kind === 'payment_plan_catchup' && uc.amt === grossUp(f2.amount_cents + f2.plan_fee_cents), short({ u, amt: uc.amt }));
      await fn('stripe_checkout', { action: 'simulate_complete', token: uc.token });
      const [f3] = await rowsOf(s.plan.id);
      const v2 = await fn('payment_plans', { action: 'member_plan' }, { token: mt });
      check('S2: paid, and the plan is current again', f3.status === 'paid' && v2.plan?.status === 'current', short({ f3: f3.status, v: v2.plan?.status }));
    }

    // ── S3: the card keeps failing, the plan lapses, the family comes back ─
    if (run('S3')) {
      console.log('M8 · S3 lapse and reinstate');
      const s = await start(3, 0, '2027-05');
      await realCard(s.plan, 'tok_chargeCustomerFail');
      const [first] = await rowsOf(s.plan.id);
      // Three tries already behind it, the last 14 days after the first.
      await sql(`update payment_plan_installments set due_date = ${q(today)}, status = 'retrying', attempt_count = 3,
        first_failed_at = now() - interval '15 days', last_error = 'declined' where id = ${q(first.id)}`);
      await cron();
      const p0 = await planOf(s.appId);
      // PLAN.md CJ (Doug 11/7): a failed card cancels nothing; only a missed deadline does.
      check('S3: the fourth decline keeps the plan open', p0.status === 'active' && !p0.ended_reason, short({ status: p0.status, why: p0.ended_reason }));
      const tasks = await sql(`select kind, summary from admin_tasks where tenant_id = ${q(tenantId)} and source_id = ${q(p0.id)} and completed_at is null and dismissed_at is null`);
      check('S3: the board is told it still hasn\'t gone through', tasks.some(t => t.kind === 'plan.payment_failed' && /still hasn.t gone through/.test(t.summary)), short(tasks));
      // Then a deadline passes unpaid: stand in for the daily run's deadline check.
      await sql(`update payment_plans set status = 'lapsed', ended_reason = 'deadline', lapsed_at = now() where id = ${q(p0.id)}`);
      const p = await planOf(s.appId);
      const mt = await memberTok(p);
      const v = await fn('payment_plans', { action: 'member_plan' }, { token: mt });
      check('S3: they see what it takes to come back: overdue plus $50', v.plan?.status === 'lapsed' && v.plan.reinstate?.fee_cents === 5000
        && v.plan.reinstate.dues_cents === first.amount_cents, short(v.plan?.reinstate));
      const r = await fn('stripe_checkout', { action: 'plan_reinstate' }, { token: mt });
      const rc = r.ok ? claims(r.url) : {};
      check('S3: reinstating charges overdue + plan fee + $50, with the card fee', r.ok && rc.amt === grossUp(first.amount_cents + first.plan_fee_cents + 5000), short({ r, amt: rc.amt }));
      await fn('stripe_checkout', { action: 'simulate_complete', token: rc.token });
      const p2 = await planOf(s.appId);
      const [f] = await rowsOf(p.id);
      const open = await sql(`select kind from admin_tasks where tenant_id = ${q(tenantId)} and source_id = ${q(p.id)} and completed_at is null`);
      check('S3: back on: plan active, overdue paid, the lapse task closed', p2.status === 'active' && !p2.ended_reason && f.status === 'paid' && !open.some(t => t.kind === 'plan.lapsed'), short({ p: p2.status, f: f.status, open }));
    }

    // ── S4: the board's test button, then paying off early ─────────────────
    if (run('S4')) {
      console.log('M8 · S4 pay off early');
      const s = await start(4, 15000, '2027-06');
      plans.s4 = s.plan;
      const sim = await fn('payment_plans', { action: 'simulate_charge', plan_id: s.plan.id }, { token: admin });
      const rows = await rowsOf(s.plan.id);
      check('S4: "Simulate the next payment" pays payment 2', sim.ok && rows[1].status === 'paid', short(sim));
      const mt = await memberTok(await planOf(s.appId));
      const left = rows.filter(r => r.status !== 'paid').reduce((n, r) => n + r.amount_cents, 0);
      const o = await fn('stripe_checkout', { action: 'plan_payoff' }, { token: mt });
      const oc = o.ok ? claims(o.url) : {};
      check('S4: paying off charges the rest of the dues, no more plan fees', o.ok && oc.amt === grossUp(left), short({ amt: oc.amt, want: grossUp(left) }));
      await fn('stripe_checkout', { action: 'simulate_complete', token: oc.token });
      const after = await rowsOf(s.plan.id);
      const p = await planOf(s.appId);
      check('S4: everything paid, plan finished, unpaid plan fees dropped',
        p.status === 'completed' && after.every(r => r.status === 'paid') && after.slice(2).every(r => r.plan_fee_cents === 0), short({ p: p.status, fees: after.map(r => r.plan_fee_cents) }));
      const [hh] = await sql(`select dues_paid_for_year from households where id = ${q(p.household_id)}`);
      check('S4: the gate is on', hh.dues_paid_for_year === true);
    }

    // ── S5: the family cancels ─────────────────────────────────────────────
    if (run('S5')) {
      console.log('M8 · S5 cancel');
      const s = await start(5, 0, '2027-05');
      plans.s5 = s.plan;
      const mt = await memberTok(s.plan);
      const c = await fn('payment_plans', { action: 'member_cancel' }, { token: mt });
      const p = await planOf(s.appId);
      check('S5: cancelled, no refund, treated like a lapse', c.ok && p.status === 'cancelled' && p.ended_reason === 'member_cancelled', short({ c: c.ok, p: p.status }));
      check('S5: coming back is just the $50 fee (nothing overdue yet)', c.plan?.reinstate?.total_cents === 5000, short(c.plan?.reinstate));
      const tasks = await sql(`select kind from admin_tasks where tenant_id = ${q(tenantId)} and source_id = ${q(p.id)}`);
      check('S5: the board sees the cancellation', tasks.some(t => t.kind === 'plan.cancelled'), short(tasks));
    }

    // ── S6: who can't start a plan ─────────────────────────────────────────
    if (run('S6')) {
      console.log('M8 · S6 late joiner, membership type');
      const single = await mkApp(7, 'single');
      const r1 = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: single, today_cents: 0, payoff_month: '2027-05' });
      check('S6: not offered for a type the club left out', !r1.ok && /type/.test(r1.error || ''), short(r1));
      // Half was due October 1, which has passed.
      await setSettings({ ...planCfg, milestones: [{ date: '2026-10-01', min_pct: 50, label: 'Half paid' }, { date: '2027-07-15', min_pct: 100, label: 'Paid in full' }] });
      const late = await mkApp(6);
      const r2 = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: late, today_cents: 0, payoff_month: '2027-05' });
      check('S6: a late joiner must pay half today', !r2.ok && r2.min_today_cents === 30000 && /\$300\.00/.test(r2.error || ''), short(r2));
      const r3 = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: late, today_cents: 30000, payoff_month: '2027-05' });
      check('S6: with $300 today it works', r3.ok, short(r3));
      await setSettings(planCfg);
    }

    // ── S7: real Stripe checkout pages are made ────────────────────────────
    if (run('S7')) {
      console.log('M8 · S7 real Stripe checkout pages');
      await setSettings(planCfg, { test_mode: false });
      const a8 = await mkApp(8);
      const r0 = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: a8, today_cents: 0, payoff_month: '2027-05' });
      const p8 = await planOf(a8);
      check('S7: $0 today opens a real Stripe "save card" page', r0.ok && /^https:\/\/checkout\.stripe\.com\//.test(r0.url || '') && /^cus_/.test(p8?.stripe_customer_id || ''), short(r0));
      const a9 = await mkApp(9);
      const r1 = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: a9, today_cents: 10000, payoff_month: '2027-05' });
      check('S7: money today opens a real Stripe payment page', r1.ok && /^https:\/\/checkout\.stripe\.com\//.test(r1.url || ''), short(r1));
      if (plans.s5) {
        const r2 = await fn('stripe_checkout', { action: 'plan_reinstate' }, { token: await memberTok(plans.s5) });
        check('S7: reinstating opens a real Stripe page', r2.ok && /checkout\.stripe\.com/.test(r2.url || ''), short(r2));
      }
      if (plans.s2) {
        const r3 = await fn('stripe_checkout', { action: 'plan_card' }, { token: await memberTok(plans.s2) });
        check('S7: updating a card opens a real Stripe page', r3.ok && /checkout\.stripe\.com/.test(r3.url || ''), short(r3));
      }
      await setSettings(planCfg);
    }

    // ── S8: the board's table, the family's app ────────────────────────────
    if (run('S8')) {
      console.log('M8 · S8 the board table and the member app');
      const l = await fn('payment_plans', { action: 'list_plans' }, { token: admin });
      const st = new Set((l.plans || []).map(p => p.status));
      check('S8: the board table lists every plan with paid, balance, next, status, fob',
        l.ok && (l.plans || []).every(p => 'paid_cents' in p && 'balance_cents' in p && 'fob' in p) && st.has('paid_in_full') && st.has('cancelled'), short([...st]));
      if (plans.s2) {
        const me = await fn('member_auth', { action: 'me' }, { token: await memberTok(plans.s2) });
        check('S8: the member app gets the family\'s plan', me.ok && me.plan?.id === plans.s2.id, short(me.plan));
      }
    }

    // ── S9: not paid in full by the deadline ───────────────────────────────
    if (run('S9')) {
      console.log('M8 · S9 the paid-in-full deadline');
      await setSettings({ ...planCfg, milestones: [{ date: '2026-09-01', min_pct: 50, label: 'Half paid' }, { date: '2026-10-06', min_pct: 100, label: 'Paid in full' }] });
      // A plan never ends over a payment the board hadn't approved (PLAN.md
      // S): here the board had ticked every payment still owed.
      await sql(`update payment_plan_installments set approved_at = now()
        where tenant_id = ${q(tenantId)} and status in ('pending', 'retrying') and approved_at is null`);
      const c = await cron();
      const ended = await sql(`select id, status, ended_reason, enforced_at, household_id from payment_plans where tenant_id = ${q(tenantId)} and ended_reason = 'deadline'`);
      check('S9: plans still owing after the deadline end', c.ok && c.past_deadline >= 1 && ended.length >= 1, short({ c, ended: ended.length }));
      const e = ended.find(p => p.household_id);
      if (e) {
        const [hh] = await sql(`select dues_paid_for_year from households where id = ${q(e.household_id)}`);
        const gate = await sql(`select bool_or(can_unlock_gate) any_on from household_members where household_id = ${q(e.household_id)} and role in ('primary','adult','teen')`);
        const fob = await sql(`select count(*)::int n from admin_tasks where source_id = ${q(e.id)} and kind = 'plan.fob_off'`);
        // PLAN.md CI1: a keyfob to-do only when the family has a keyfob on the doors' list.
        const [{ n: fobsOn }] = await sql(`select count(*)::int as n from keyfobs where household_id = ${q(e.household_id)} and status = 'active' and card_number is not null`);
        check('S9: gate unlock off right away, and a keyfob to-do only if they have a keyfob', !!e.enforced_at && hh.dues_paid_for_year === false && gate[0].any_on === false && fob[0].n === (fobsOn > 0 ? 1 : 0), short({ e, hh, gate, fob, fobsOn }));
      }
    }

    // ── W: the board's $1 test level, paid weekly (PLAN.md BN1) ────────────
    if (run('W')) {
      console.log('BN1 · W the $1 test level, weekly');
      const LEVEL = { slug: 'board_test', label: 'Test: $1 a week (board only)', price_cents: 500, description: 'Checks real card payments.', test: true };
      // Like Bishop: no Poolside fees, card fee passed on.
      await setSettings(planCfg);
      await sql(`update settings set value = jsonb_set(value, '{membership_tiers}', (value->'membership_tiers') || ${q(JSON.stringify([LEVEL]))}::jsonb)
        where tenant_id = ${q(tenantId)}; update tenants set platform_fees_waived = true, platform_fees_waived_reason = 'Test club, like Bishop' where id = ${q(tenantId)}`);
      const wBase = String((Number(phoneBase) + 500000) % 1000000).padStart(6, '0');
      const boardEmail = `plan-board-${STAMP}@example.com`;
      await sql(`insert into admin_users (tenant_id, username, email, password_hash, display_name, role_template, scopes, is_default_pw, active)
        values (${q(tenantId)}, ${q(`simtest-board-${STAMP}`)}, ${q(boardEmail)}, 'x', 'Board Tester', 'owner', array[]::text[], false, true)`);

      const pub = await fn('tenant_public', { slug: SLUG });
      const pubL = await fn('tenant_public', { slug: SLUG, level: 'board_test' });
      check('W: families don\'t see it; its link does', pub.ok && !(pub.tiers || []).some(t => t.slug === 'board_test')
        && (pubL.tiers || []).some(t => t.slug === 'board_test' && t.test === true), short({ pub: (pub.tiers || []).map(t => t.slug), link: (pubL.tiers || []).map(t => t.slug) }));

      const quote = await fn('applications', { action: 'quote', slug: SLUG, tier_slug: 'board_test' });
      const ch = quote.plan?.choice;
      const want = [0, 7, 14, 21, 28].map(n => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); });
      check('W: the quote is weekly: $1 today and every 7 days, $1.34 each with the card fee',
        quote.plan?.weekly === true && ch?.ok && ch.rows.map(r => r.due_date).join() === want.join() && ch.rows.every(r => r.amount_cents === 100 && r.charge_cents === grossUp(100)),
        short({ weekly: quote.plan?.weekly, rows: ch?.rows?.map(r => [r.due_date, r.charge_cents]) }));

      const body = (email, n) => ({
        action: 'submit', slug: SLUG, family_name: `SimTest Weekly ${n}`, primary_name: `Weekly Tester ${n}`,
        primary_email: email, primary_phone: `555${wBase}${n}`,
        address: '1 Test Lane', city: 'Testville', zip: '00000', emergency_contact: 'Emergency Tester — (555) 000-0000',
        adults: [{ name: `Weekly Tester ${n}`, dob: '1980-01-01', email, phone: `555${wBase}${n}` }], children: [],
        waivers_accepted: { rules: true, guest: true, party: true, sitter: true, waiver: true },
        tier_slug: 'board_test', payment_method: 'stripe_plan',
      });
      const no = await fn('applications', body(`someone-${STAMP}@example.com`, 1));
      check('W: someone who isn\'t on the board can\'t join on it', no.status === 403 && /only for the club's board/.test(no.error || ''), short(no));
      const yes = await fn('applications', body(`plan-board-${STAMP}+w2@example.com`, 2));
      const appId = yes.application_id;
      check('W: a board email with +w2 can', yes.ok && !!appId, short(yes));
      if (appId) {
        const r = await fn('stripe_checkout', { action: 'application_plan', plan_signature: PLAN_SIG, application_id: appId, today_cents: ch?.today_cents, payoff_month: ch?.payoff_month });
        const c = r.ok ? claims(r.url) : null;
        check('W: checkout takes $1.34 today and says weekly', r.ok && c?.amt === grossUp(100) && /4 weekly payments/.test(c?.desc || ''), short({ r, amt: c?.amt, desc: c?.desc }));
        if (c) await fn('stripe_checkout', { action: 'simulate_complete', token: c.token });
        const plan = await planOf(appId);
        const rows = plan ? await rowsOf(plan.id) : [];
        check('W: saved as a weekly plan, five payments on the weekly dates', plan?.plan_type === 'weekly'
          && rows.map(x => x.due_date).join() === want.join() && rows[0].status === 'paid' && rows.slice(1).every(x => x.status === 'pending'),
          short({ type: plan?.plan_type, rows: rows.map(x => [x.due_date, x.status]) }));
        const up = await fn('payment_plans', { action: 'upcoming', all: true }, { token: admin });
        const mine = (up.upcoming || []).filter(u => u.plan_id === plan?.id);
        check('W: Upcoming lists the next ones as weekly', up.ok && mine.length === 4 && mine.every(u => u.weekly === true), short(mine.map(u => [u.due_date, u.weekly])));
        if (plan) {
          await realCard(plan, 'tok_visa');
          await sql(`update payment_plan_installments set due_date = ${q(today)} where plan_id = ${q(plan.id)} and sequence = 2`);
          const cr = await cron();
          const after = await rowsOf(plan.id);
          const two = after.find(x => x.sequence === 2);
          const pi = two?.stripe_payment_intent_id ? await stripe('GET', `/payment_intents/${two.stripe_payment_intent_id}`, {}, acct) : null;
          check('W: the daily run charges the approved weekly payment, $1.34, to the saved card',
            cr.ok && two?.status === 'paid' && pi?.status === 'succeeded' && pi?.amount === grossUp(100), short({ st: two?.status, pi: pi && { s: pi.status, a: pi.amount } }));
          check('W: the rest wait for their own dates', after.filter(x => x.sequence > 2).every(x => x.status === 'pending'), short(after.map(x => x.status)));
        }
      }
    }
    return true;
  } catch (e) {
    check('live run', false, e.stack || e.message);
    return false;
  } finally {
    // Everything this run made goes, pass or fail.
    try {
      if (tenantId) {
        await sql(`delete from stripe_processed_events where tenant_id = ${q(tenantId)};
          delete from tenants where id = ${q(tenantId)}`);
        const left = await sql(`select (select count(*) from tenants where id = ${q(tenantId)})::int t,
          (select count(*) from payment_plans where tenant_id = ${q(tenantId)})::int p`);
        check('cleanup: the test club and its plans are gone', left[0].t === 0 && left[0].p === 0, short(left));
      }
      if (acct) {
        const d = await stripe('DELETE', `/accounts/${acct}`);
        check('cleanup: the Stripe test account is deleted', d.deleted === true, short(d));
      }
    } catch (e) { check('cleanup', false, e.message); }
    console.log(`  (${calls} Edge Function calls)`);
  }
}

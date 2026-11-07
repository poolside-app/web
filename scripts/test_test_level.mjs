#!/usr/bin/env node
// Targeted check for the $1 test level (PLAN.md BN1, BK5; Doug 11/1: "lets
// do weekly"). A hidden membership level only the board can join on, whose
// payment plan is $1 today and then $1 a week for 4 weeks, so real card
// payments can be checked with real money in a month. Monthly plans don't
// change.
//
// Offline only, no calls. The live part is `ONLY=W node scripts/test_flex_plan.mjs --live`.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const short = o => String(JSON.stringify(o)).slice(0, 300);
const fnSrc = name => read(`supabase/functions/${name}/index.ts`);
const sharedSrc = name => read(`supabase/functions/_shared/${name}.ts`);

let tl = null;
try { tl = await importTs(new URL('supabase/functions/_shared/test_level.ts', root)); } catch (e) { tl = null; }

console.log('TL1 · the level and who can join on it (offline)');
{
  check('_shared/test_level.ts exists', !!tl);
  const L = tl?.TEST_LEVEL ?? {};
  check('the level: board_test, $5, marked test, says it is board only',
    L.slug === 'board_test' && L.price_cents === 500 && L.test === true && /board only/i.test(L.label || ''), short(L));
  const tiers = [{ slug: 'family', label: 'Family', price_cents: 60000 }, { slug: 'single', label: 'Single', price_cents: 30000 }, L];
  check('hidden from the public list', tl && tl.publicTiers(tiers).map(t => t.slug).join() === 'family,single', short(tl?.publicTiers(tiers)));
  check('shown with its own link', tl && tl.publicTiers(tiers, 'board_test').some(t => t.slug === 'board_test'));
  check('another level= shows nothing hidden', tl && !tl.publicTiers(tiers, 'family').some(t => t.test) && !tl.publicTiers(tiers, 'nonsense').some(t => t.test));
  check('isTestTier', tl && tl.isTestTier(L) && !tl.isTestTier(tiers[0]) && !tl.isTestTier(null));
  check('isTestSlug reads the club\'s levels', tl && tl.isTestSlug(tiers, 'board_test') && !tl.isTestSlug(tiers, 'family') && !tl.isTestSlug([], 'board_test'));

  const same = (a, b) => tl && tl.sameInbox(a, b);
  check('an email with +word is the same inbox', same('Doug.F+test1@Gmail.com', 'doug.f@gmail.com') && same('doug.f@gmail.com', 'doug.f@gmail.com'));
  check('a different email is not', !same('dougf@gmail.com', 'doug.f@gmail.com') && !same('doug.f@gmail.co', 'doug.f@gmail.com') && !same('', 'doug.f@gmail.com') && !same(null, null));
  const admins = [{ email: 'treasurer@club.org', phone_e164: '+19255550101' }, { email: null, phone_e164: null }];
  check('a board login\'s email (any +word) may join', tl && tl.boardMatch(admins, { email: 'treasurer+t2@club.org', phone: '+15550100001' }));
  check('a board login\'s phone may join', tl && tl.boardMatch(admins, { email: 'someone@else.com', phone: '+19255550101' }));
  check('anyone else may not', tl && !tl.boardMatch(admins, { email: 'family@home.com', phone: '+15550100002' }) && !tl.boardMatch(admins, { email: null, phone: null }));
  check('the refusal says it is for the board and how to use the board email',
    tl && /board/i.test(tl.NOT_BOARD) && /\+/.test(tl.NOT_BOARD), tl?.NOT_BOARD);
}

console.log('TL2 · the weekly schedule (offline)');
{
  const fp = await importTs(new URL('supabase/functions/_shared/flex_plan.ts', root));
  const ps = await importTs(new URL('supabase/functions/_shared/payment_schedule.ts', root));
  const rules = ps.resolveRules({ milestones: [{ date: '04-10', min_pct: 50, label: 'Half paid' }, { date: '07-15', min_pct: 100, label: 'Paid in full' }], min_installment_cents: 2500 }, 2027, 10);
  check('flex_plan.ts has weeklySchedule', typeof fp.weeklySchedule === 'function');
  if (typeof fp.weeklySchedule === 'function') {
    const w = fp.weeklySchedule({ totalCents: 500, startDate: '2026-11-20', rules });
    check('five $1 payments', w.ok && w.schedule.length === 5 && w.schedule.every(r => r.amount_cents === 100), short(w));
    check('today, then every 7 days (across the month)', w.schedule.map(r => r.due_date).join() === '2026-11-20,2026-11-27,2026-12-04,2026-12-11,2026-12-18', short(w.schedule?.map(r => r.due_date)));
    check('numbered 1 to 5, $1 today', w.schedule.map(r => r.sequence).join() === '1,2,3,4,5' && w.today_cents === 100);
    check('the payoff date is the last payment', w.payoff_date === '2026-12-18');
    check('the club\'s deadlines are checked (and met)', w.checks.length === 2 && w.checks.every(c => c.ok), short(w.checks));
    const odd = fp.weeklySchedule({ totalCents: 503, startDate: '2026-11-20', rules });
    check('the last one absorbs the rounding', odd.ok && odd.schedule.slice(0, 4).every(r => r.amount_cents === 100) && odd.schedule[4].amount_cents === 103, short(odd.schedule?.map(r => r.amount_cents)));
    const tiny = fp.weeklySchedule({ totalCents: 3, startDate: '2026-11-20', rules });
    check('too little to split is refused', !tiny.ok, short(tiny));
  }
}

console.log('TL3 · the quote a board member sees (offline)');
{
  const pq = await importTs(new URL('supabase/functions/_shared/plan_quote.ts', root));
  const ops = await importTs(new URL('supabase/functions/_shared/plan_ops.ts', root));
  const fp = await importTs(new URL('supabase/functions/_shared/flex_plan.ts', root));
  const L = tl?.TEST_LEVEL ?? { slug: 'board_test', price_cents: 500, test: true };
  const tiers = [{ slug: 'family', label: 'Family', price_cents: 60000 }, L];
  const club = (over = {}) => ({
    tenantId: 't', slug: 'x', name: 'X', tz: 'America/Los_Angeles', today: '2026-11-20', sv: { membership_tiers: tiers }, opensMonth: 10,
    cfg: ops.planConfig({ payments: { plan: {
      enabled: true, access_when: 'half_paid', billing_day: 1,
      milestones: [{ date: '04-10', min_pct: 50, label: 'Half paid' }, { date: '07-15', min_pct: 100, label: 'Paid in full' }],
      ...(over.plan || {}),
    } } }),
    passFee: true, pct: 0.029, fixed: 30, stripeAccount: 'acct_x', chargesEnabled: true, feesWaived: true, testMode: false,
    clubUrl: 'https://x.poolsideapp.com', ...over,
  });
  const WAIVED = { waived: true };
  const q = pq.quotePlan(club(), { totalCents: 500, tierSlug: 'board_test', year: 2027, policy: WAIVED });
  check('offered, and marked weekly', q.available && q.weekly === true, short({ a: q.available, w: q.weekly, r: q.reason }));
  const c = q.choice || {};
  check('$1 today and four weekly $1 payments', c.ok && c.rows?.length === 5 && c.rows[0].today && c.rows.every(r => r.amount_cents === 100)
    && c.rows.map(r => r.due_date).join() === '2026-11-20,2026-11-27,2026-12-04,2026-12-11,2026-12-18', short(c.rows));
  check('each is $1.34 with the card fee passed on', c.rows?.every(r => r.charge_cents === 134 && r.plan_fee_cents === 0), short(c.rows?.map(r => r.charge_cents)));
  check('totals: $5 in dues, $6.70 charged', c.totals?.dues_cents === 500 && c.totals?.charge_cents === 670, short(c.totals));
  check('today and the payoff month come from the schedule', c.today_cents === 100 && c.payoff_month === '2026-12', short({ t: c.today_cents, m: c.payoff_month }));
  const picked = pq.quotePlan(club(), { totalCents: 500, tierSlug: 'board_test', year: 2027, policy: WAIVED, todayCents: 0, payoffMonth: '2027-07' });
  check('a picked amount or month changes nothing', picked.choice?.ok && picked.choice.rows.length === 5 && picked.choice.today_cents === 100);
  const restricted = pq.quotePlan(club({ plan: { tiers: ['family'] } }), { totalCents: 500, tierSlug: 'board_test', year: 2027, policy: WAIVED });
  check('offered even when the club limits plans to some levels', restricted.available && restricted.weekly, short(restricted));
  const late = pq.quotePlan(club({ today: '2027-07-20' }), { totalCents: 500, tierSlug: 'board_test', year: 2027, policy: WAIVED });
  check('offered after the paid-in-full date too (it is four weeks long)', late.available && late.choice?.ok, short(late));
  const off = pq.quotePlan(club({ plan: { enabled: false } }), { totalCents: 500, tierSlug: 'board_test', year: 2027, policy: WAIVED });
  check('not offered when the club has plans off', !off.available);
  const fee = pq.quotePlan(club({ feesWaived: false }), { totalCents: 500, tierSlug: 'board_test', year: 2027, policy: { waived: false } });
  check('a club paying Poolside\'s fees gets the plan fee like any plan', fee.choice?.ok && fee.choice.totals.plan_fee_cents > 0, short(fee.choice?.totals));

  // Monthly plans are what they were.
  const fam = pq.quotePlan(club(), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: WAIVED, todayCents: 10000, payoffMonth: '2027-05' });
  const direct = fp.flexSchedule({ totalCents: 60000, todayCents: 10000, payoffMonth: '2027-05', startDate: '2026-11-20', rules: ops.rulesFor(club(), 2027) });
  check('a real level is still monthly, exactly as before', !fam.weekly && fam.choice?.ok && direct.ok
    && fam.choice.rows.map(r => `${r.due_date}:${r.amount_cents}`).join() === direct.schedule.map(r => `${r.due_date}:${r.amount_cents}`).join(), short(fam.choice?.rows?.map(r => r.due_date)));
  check('a real level still has the payoff months to pick from', fam.months.length > 1);

  const view = ops.planView(club(), { id: 'p', status: 'active', total_cents: 500, family_name: 'Test', plan_type: 'weekly', stripe_payment_method_id: 'pm_1' },
    [{ id: 'a', sequence: 1, due_date: '2026-11-20', amount_cents: 100, plan_fee_cents: 0, card_fee_cents: 34, status: 'paid' }]);
  check('the plan view says weekly', view.weekly === true);
  const mview = ops.planView(club(), { id: 'p', status: 'active', total_cents: 500, family_name: 'Test', plan_type: 'flex' }, []);
  check('and a monthly plan is not', mview.weekly === false);
}

console.log('TL4 · the server (offline)');
{
  const ap = fnSrc('applications');
  const submit = ap.slice(ap.indexOf("action === 'submit'"), ap.indexOf("action === 'quote'"));
  check('signup: the test level checks the board login first',
    /isTestSlug\(/.test(submit) && /boardMatch\(/.test(submit) && /NOT_BOARD/.test(submit) && submit.indexOf('isTestSlug(') > submit.indexOf('tierFitError'), 'applications submit');
  check('signup: the board logins are this club\'s active ones',
    /from\('admin_users'\)\.select\('email, phone_e164'\)\.eq\('tenant_id', tenant\.id\)\.eq\('active', true\)/.test(submit));
  const tp = fnSrc('tenant_public');
  check('tenant_public hides it unless asked by its link', /publicTiers\(rawTiers, (body|level)/.test(tp) || /publicTiers\(Array\.isArray\(rawTiers\)/.test(tp), 'tenant_public');
  check('the club\'s share page leaves it out of "from $…"', /publicTiers\(/.test(fnSrc('tenant_share')));
  const sc = fnSrc('stripe_checkout');
  const ap2 = sc.slice(sc.indexOf("action === 'application_plan'"));
  check('checkout saves a weekly plan as weekly', /plan_type: q\.weekly \? 'weekly' : 'flex'/.test(ap2));
  check('Stripe\'s page says weekly for it', /q\.weekly \? 'weekly' : 'monthly'/.test(ap2));
  const pp = fnSrc('payment_plans');
  check('Upcoming knows which plans are weekly', /weekly: p\.plan_type === 'weekly'/.test(pp) && /plan_type/.test(pp.slice(pp.indexOf("action === 'upcoming'"), pp.indexOf("action === 'approve'"))));
  check('the plan view says weekly', /weekly: plan\.plan_type === 'weekly'/.test(sharedSrc('plan_ops')));
  check('Insights leaves test-level families out of the dues', /isTestSlug\(tiers, r\.tier/.test(sharedSrc('dues_totals')));
  check('plan_quote builds the weekly plan for the test level', /isTestSlug\(/.test(sharedSrc('plan_quote')) && /weeklySchedule\(/.test(sharedSrc('plan_quote')));
}

console.log('TL5 · the screens (offline)');
{
  const apply = read('apply.html');
  check('the join form passes ?level= to tenant_public', /level: (LEVEL|new URLSearchParams)/.test(apply) && /params\.get\('level'\)|searchParams\.get\('level'\)|\.get\('level'\)/.test(apply));
  check('with the test level, it is the only level shown, with a note', /TEST_ONLY|t\.test/.test(apply.slice(apply.indexOf('function paintTiers'), apply.indexOf('function paintTiers') + 2500)) && /Board only/.test(apply) && /board email/.test(apply) && /555/.test(apply));
  check('the plan option says weekly for it', /id="plan-opt-sub"/.test(apply) && /PLAN_QUOTE\.weekly/.test(apply) && /a week for \$\{/.test(apply));
  check('Money → Upcoming says "a week" for a weekly plan', /u\.weekly \? 'a week' : 'a month'/.test(read('club/admin/upcoming.html')));
  const pay = read('club/admin/payments.html');
  check('the plans list says weekly for it', /p\.weekly \? 'weekly' : 'monthly'/.test(pay));
  check('Money → Payments has the test level box, owner only', /id="test-level-card"/.test(pay) && /data-owner-only[^>]*id="test-level-card"|id="test-level-card"[^>]*data-owner-only/.test(pay));
  check('it adds and removes the level and shows the link', /function addTestLevel/.test(pay) && /function removeTestLevel/.test(pay) && /apply\.html\?level=\$\{TEST_LEVEL\.slug\}/.test(pay));
  const m = pay.match(/const TEST_LEVEL = (\{[^;]+\});/);
  let pageLevel = null; try { pageLevel = m ? vm.runInNewContext('(' + m[1] + ')') : null; } catch { pageLevel = null; }
  const L = tl?.TEST_LEVEL;
  check('the page\'s level is the server\'s', !!(pageLevel && L) && pageLevel.slug === L.slug && pageLevel.price_cents === L.price_cents && pageLevel.label === L.label && pageLevel.test === true, short(pageLevel));
  check('the levels editor marks it hidden', /isTest|t\.test/.test(pay.slice(pay.indexOf('const Tiers = '), pay.indexOf('const Tiers = ') + 4000)));

  // The picker draws the weekly plan with nothing to choose.
  const src = read('js/plan-picker.js');
  const root2 = { innerHTML: '' };
  const ctx = { window: {}, document: { getElementById: () => null, body: { contains: () => true }, activeElement: null }, setTimeout, clearTimeout };
  vm.runInNewContext(src, ctx);
  const P = ctx.window.PlanPicker;
  const rows = ['2026-11-20', '2026-11-27', '2026-12-04', '2026-12-11', '2026-12-18'].map((d, i) => ({ sequence: i + 1, due_date: d, today: i === 0, amount_cents: 100, plan_fee_cents: 0, card_fee_cents: 34, charge_cents: 134 }));
  const quote = { available: true, weekly: true, total_cents: 500, min_payment_cents: 0, months: [{ value: '2026-12', label: 'December 2026' }], deadlines: [], access_when: 'half_paid',
    choice: { ok: true, today_cents: 100, payoff_month: '2026-12', rows, totals: { dues_cents: 500, plan_fee_cents: 0, card_fee_cents: 170, charge_cents: 670 }, checks: [] } };
  P.mount(root2, quote, () => {});
  check('weekly: no "Pay today" or "Paid off by" boxes', !/pp-today|pp-month/.test(root2.innerHTML), root2.innerHTML.slice(0, 200));
  check('weekly: says $1.34 today, then every week, and lists all five', /every week/i.test(root2.innerHTML) && (root2.innerHTML.match(/\$1\.34/g) || []).length >= 5, root2.innerHTML.slice(0, 300));
  // Nothing goes to checkout until the plan agreement is signed (PLAN.md CL2);
  // test_plan_agreement signs it in Chrome and checks what's sent.
  check('weekly: waits for the plan agreement\'s signature', P.choice() === null && /Sign the payment plan agreement/.test(P.error() || ''), short(P.error()));
  const root3 = { innerHTML: '' };
  P.mount(root3, { ...quote, weekly: false }, () => {});
  check('monthly: the boxes are still there', /pp-today/.test(root3.innerHTML) && /pp-month/.test(root3.innerHTML));
}

console.log('TL6 · the join form from the test link (offline, in Chrome)');
{
  const { launch, attach, FAMILY } = await import('./demo_video/harness.mjs');
  const { respond } = await import('./demo_video/data.mjs');
  const L = tl?.TEST_LEVEL ?? { slug: 'board_test', label: 'Test', price_cents: 500, test: true };
  const rows = ['2027-06-19', '2027-06-26', '2027-07-03', '2027-07-10', '2027-07-17'].map((d, i) => ({ sequence: i + 1, due_date: d, today: i === 0, amount_cents: 100, plan_fee_cents: 0, card_fee_cents: 34, charge_cents: 134 }));
  const weeklyQuote = { available: true, weekly: true, total_cents: 500, min_payment_cents: 0, months: [{ value: '2027-07', label: 'July 2027' }], deadlines: [], access_when: 'half_paid',
    choice: { ok: true, today_cents: 100, payoff_month: '2027-07', rows, totals: { dues_cents: 500, plan_fee_cents: 0, card_fee_cents: 170, charge_cents: 670 }, checks: [] } };
  const asked = [];
  const answer = (f, body, ctx) => {
    if (f === 'tenant_public') {
      asked.push(body);
      const base = respond(f, body, ctx);
      return body.level === L.slug ? { ...base, tiers: [...(base.tiers || []), L] } : base;
    }
    if (f === 'applications' && body.action === 'quote' && body.tier_slug === L.slug) {
      return { ok: true, price: { base_cents: 500, discount_cents: 0, credit_cents: 0, amount_due_cents: 500, code: null, fob_count: 0, fob_cents: 0, fob_fee_cents: 1500, fob_room: 4 }, plan: weeklyQuote };
    }
    return respond(f, body, ctx);
  };
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    await attach(page, { answer });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(FAMILY + '/apply.html?level=board_test', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(r => setTimeout(r, 500));
    check('the page asks for the test level by its link', asked.some(b => b.level === 'board_test'), short(asked));
    const tiers = await page.$$eval('input[name="tier_slug"]', els => els.map(e => ({ v: e.value, c: e.checked })));
    check('only the test level is offered, already picked', tiers.length === 1 && tiers[0].v === 'board_test' && tiers[0].c, short(tiers));
    const note = await page.$eval('#tiers-box', el => el.innerText);
    check('with the board-only note (board email, +test1, a 555 phone)', /Board only/.test(note) && /\+test1/.test(note) && /555/.test(note), note.slice(0, 200));
    // The payment step: pick the plan and see what it draws.
    const drawn = await page.evaluate(async () => {
      await refreshQuote();
      const r = document.querySelector('input[name="payment_method"][value="stripe_plan"]');
      if (r) { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); }
      paintPlanLabel();
      await new Promise(res => setTimeout(res, 200));
      return { sub: document.getElementById('plan-opt-sub')?.textContent || '', shown: document.getElementById('pay-opt-stripe-plan')?.style.display !== 'none',
        picker: document.getElementById('plan-picker')?.innerText || '', boxes: !!document.getElementById('pp-today') };
    });
    check('the plan option says $1.34 today, then $1.34 a week for 4 weeks', drawn.shown && /\$1\.34 today, then \$1\.34 a week for 4 weeks/.test(drawn.sub), short(drawn));
    check('the picker lists the weekly payments, with nothing to choose', !drawn.boxes && /every week/.test(drawn.picker) && (drawn.picker.match(/\$1\.34/g) || []).length >= 5, short(drawn));
    check('no page errors', !errors.length, errors.join(' | '));

    // Without the link: the usual levels, no note.
    const page2 = await browser.newPage();
    await attach(page2, { answer });
    await page2.goto(FAMILY + '/apply.html', { waitUntil: 'networkidle0', timeout: 45000 });
    const plain = await page2.$$eval('input[name="tier_slug"]', els => els.map(e => e.value));
    const plainNote = await page2.$eval('#tiers-box', el => el.innerText);
    check('without the link: the club\'s own levels, no test level, no note', plain.length > 1 && !plain.includes('board_test') && !/Board only/.test(plainNote), short(plain));
  } finally { await browser.close(); }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

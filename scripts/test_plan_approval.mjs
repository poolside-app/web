#!/usr/bin/env node
// Targeted check for "approve every automatic payment" (PLAN.md S).
// Offline checks read the helpers and pages and cost nothing. `--live` adds
// about 10 Edge Function calls on Bishop with a temporary family and a
// test-card plan (never sent to Stripe), removed afterward.
//
// Usage: node scripts/test_plan_approval.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 260);

console.log('S1 · one billing day (offline)');
{
  const ps = await importTs(new URL('supabase/functions/_shared/payment_schedule.ts', root));
  const fp = await importTs(new URL('supabase/functions/_shared/flex_plan.ts', root));
  const cfg = { milestones: [{ date: '04-10', min_pct: 50 }, { date: '07-15', min_pct: 100 }] };
  const rules = ps.resolveRules(cfg, 2027, 10);
  check('the billing day defaults to the 1st', rules.billingDay === 1, short(rules));
  const r = fp.flexSchedule({ totalCents: 60000, todayCents: 15000, payoffMonth: '2027-03', startDate: '2026-10-20', rules });
  check('every monthly payment is on the 1st, whatever day they joined', r.ok && r.payments.length > 0 && r.payments.every(p => p.due_date.endsWith('-01')), short(r.payments));
  const r15 = fp.flexSchedule({ totalCents: 60000, todayCents: 15000, payoffMonth: '2027-03', startDate: '2026-10-20', rules: ps.resolveRules({ ...cfg, billing_day: 15 }, 2027, 10) });
  check('a club can pick another day', r15.ok && r15.payments.every(p => p.due_date.endsWith('-15')), short(r15.payments));
  check('Payments setup has the billing day', /id="plan-billing-day"/.test(read('club/admin/payments.html')));
}

console.log('S2 · only approved payments are charged (offline)');
{
  const ops = await importTs(new URL('supabase/functions/_shared/plan_ops.ts', root));
  const row = (seq, due, approved, status = 'pending') => ({ id: 'i' + seq, sequence: seq, due_date: due, status, approved_at: approved ? '2026-10-01T00:00:00Z' : null, amount_cents: 5500 });
  check('an unapproved payment is never charged', ops.chargeableNow([row(1, '2026-11-01', false)], '2026-11-01').length === 0);
  check('an approved one is, once it\'s due', ops.chargeableNow([row(1, '2026-11-01', true)], '2026-11-01').length === 1 && ops.chargeableNow([row(1, '2026-11-01', true)], '2026-10-31').length === 0);
  check('later payments wait behind an unapproved one', ops.chargeableNow([row(1, '2026-10-01', false), row(2, '2026-11-01', true)], '2026-11-01').length === 0);
  check('approval covers retries', ops.chargeableNow([row(1, '2026-11-01', true, 'retrying')], '2026-11-05').length === 1);
  const pp = read('supabase/functions/payment_plans/index.ts');
  const cron = pp.slice(pp.indexOf("if (action === 'cron_run')"), pp.indexOf("if (action === 'cron_run')") + 6000);
  check('the daily run uses it', /chargeableNow\(/.test(cron));
  // Since PLAN.md CJ the deadline check is missedDeadline, which counts only approved payments.
  { const po = readFileSync(new URL('../supabase/functions/_shared/plan_ops.ts', import.meta.url), 'utf8');
    const md = po.slice(po.indexOf('export function missedDeadline'), po.indexOf('export function failedPaymentTask'));
    check('a plan doesn\'t end over a payment the board hadn\'t approved', /missedDeadline\(/.test(cron) && /approved_at/.test(md)); }
}

console.log('S3 · the Treasurer is asked (offline)');
{
  const pp = read('supabase/functions/payment_plans/index.ts');
  check('a task 3 days before, daily after the billing day', /payments\.approve_due/.test(pp) && /askForApproval/.test(pp) && /ASK_DAYS_BEFORE\s*=\s*3/.test(pp));
  check('it goes to the Treasurer (payments alert)', /'payments\.approve_due': 'payments'/.test(read('supabase/functions/_shared/positions.ts')));
}

console.log('S4 · Money → Upcoming (offline)');
{
  const page = read('club/admin/upcoming.html');
  check('one line per payment with its own checkbox', /type="checkbox"/.test(page) && /Approve \$\{/.test(page) && /down/.test(page) && /a month/.test(page));
  check('approve the checked ones, undo before it\'s charged', /call\('approve'/.test(page) && /call\('unapprove'/.test(page));
  check('the last 30 days of automatic charges', /history/.test(page) && /Last 30 days/.test(page));
  check('it\'s in the Money strip', /upcoming\.html/.test(read('js/admin-subtabs.js')));
}

console.log('BX · only plans under way can be approved (offline)');
{
  // Doug 11/5: "If they aren't a member I shouldn't be able to approve payments."
  // A plan is saved when the family reaches Stripe's page, before they pay.
  const { fakeDb } = await import('./lib/fake_google.mjs');
  const ops = await importTs(new URL('supabase/functions/_shared/plan_ops.ts', root));
  const inst = (plan_id, sequence, status) => ({ id: `${plan_id}-${sequence}`, plan_id, tenant_id: 't1', sequence, status, due_date: '2026-11-0' + sequence, amount_cents: 100 });
  const started = typeof ops.planStarted === 'function' ? ops.planStarted : () => null;
  check('a plan whose family left Stripe\'s page isn\'t under way', started({ stripe_payment_method_id: null }, [inst('p', 1, 'pending'), inst('p', 2, 'pending')]) === false);
  check('a saved card or a payment in makes it under way', started({ stripe_payment_method_id: 'pm_1' }, [inst('p', 1, 'pending')]) === true
    && started({ stripe_payment_method_id: null }, [inst('p', 1, 'manual'), inst('p', 2, 'pending')]) === true);

  const tables = () => ({
    payment_plans: [
      { id: 'card', application_id: 'a1', stripe_payment_method_id: 'pm_1' },
      { id: 'paid', application_id: 'a2', stripe_payment_method_id: null },
      { id: 'left', application_id: 'a3', stripe_payment_method_id: null },
    ],
    payment_plan_installments: [inst('card', 1, 'pending'), inst('paid', 1, 'paid'), inst('paid', 2, 'pending'), inst('left', 1, 'pending'), inst('left', 2, 'pending')],
  });
  let ids = null;
  try { const db = fakeDb(tables()); ids = await ops.startedPlanIds(db, db.tables.payment_plans); } catch (e) { ids = e.message; }
  check('of several plans, only the ones under way', ids instanceof Set && ids.size === 2 && ids.has('card') && ids.has('paid'), short(ids instanceof Set ? [...ids] : ids));

  let dropped = null, kept = null, none = null, db = null;
  try {
    db = fakeDb(tables());
    dropped = await ops.dropPlansIfUnstarted(db, 'a3');
    kept = await ops.dropPlansIfUnstarted(db, 'a2');
    none = await ops.dropPlansIfUnstarted(db, 'a9');
  } catch (e) { dropped = e.message; }
  check('an unpaid signup\'s plan is deleted with its payments', dropped === true && !db?.tables.payment_plans.some(p => p.id === 'left') && !db?.tables.payment_plan_installments.some(i => i.plan_id === 'left'), short({ dropped, plans: db?.tables.payment_plans.map(p => p.id) }));
  check('a plan under way is left alone (and says so)', kept === false && db?.tables.payment_plans.some(p => p.id === 'paid') && db?.tables.payment_plan_installments.filter(i => i.plan_id === 'paid').length === 2, short({ kept }));
  check('a signup with no plan is fine', none === true, short({ none }));

  const pp = read('supabase/functions/payment_plans/index.ts');
  const block = (src, start, len = 4000) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, i + len); };
  check('Money → Upcoming lists only plans under way', /planStarted\(/.test(block(pp, "if (action === 'upcoming')")));
  check('the Treasurer\'s to-do counts only plans under way', /startedPlanIds\(/.test(block(pp, 'async function askForApproval', 2500)));
  check('the approve button refuses the rest', /startedPlanIds\(/.test(block(pp, "if (action === 'approve')", 1500)));
  const apps = read('supabase/functions/applications/index.ts');
  check('the 24-hour cleanup deletes the plan with the signup', /dropPlansIfUnstarted\(/.test(block(apps, 'let deleted = 0, kept = 0;', 2000)));
  check('so does starting over on a new signup', /dropPlansIfUnstarted\(/.test(block(apps, 'async function setAsideUnfinished', 1500)));
}

console.log('BY1 · a plan waits for its first payment (offline)');
{
  // Doug 11/6: "yes... do your unpaid plan idea". Saved as 'waiting' at
  // Stripe's page; Stripe's confirmation makes it active.
  const { fakeDb } = await import('./lib/fake_google.mjs');
  const ops = await importTs(new URL('supabase/functions/_shared/plan_ops.ts', root));
  const block = (src, start, len = 4000) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, i + len); };
  const co = read('supabase/functions/stripe_checkout/index.ts');
  check('a new plan is saved as waiting, not active', /status: 'waiting'/.test(block(co, 'A family that went back from Stripe', 1800)) && !/total_cents: totalCents, status: 'active'/.test(co));
  const { readdirSync } = await import('node:fs');
  const migSrc = readdirSync(new URL('supabase/migrations/', root)).filter(f => f >= '20261106').map(f => read(`supabase/migrations/${f}`)).join('\n');
  check('the database takes the new status', /payment_plans_status_check/.test(migSrc) && /'waiting'/.test(migSrc));

  let started = null, db = null;
  try {
    db = fakeDb({ payment_plans: [{ id: 'w', status: 'waiting' }, { id: 'a', status: 'active' }, { id: 'l', status: 'lapsed' }] });
    const [w, a, l] = db.tables.payment_plans.map(p => ({ ...p }));
    await ops.startPlan(db, w); await ops.startPlan(db, a); await ops.startPlan(db, l);
    started = { w: w.status, a: a.status, l: l.status, rows: db.tables.payment_plans.map(p => p.status).join(',') };
  } catch (e) { started = e.message; }
  check('Stripe\'s confirmation makes a waiting plan active', started?.w === 'active' && started?.rows === 'active,active,lapsed', short(started));
  check('and leaves any other plan as it was', started?.a === 'active' && started?.l === 'lapsed', short(started));
  const wh = read('supabase/functions/stripe_webhook/index.ts');
  check('the webhook starts it on the first payment or the saved card', /startPlan\(/.test(block(wh, "if (kind === 'payment_plan_first' || kind === 'payment_plan_setup')", 600)));

  let swept = null;
  try {
    const old = '2026-10-20T00:00:00Z', fresh = '2026-11-05T00:00:00Z';
    db = fakeDb({
      payment_plans: [{ id: 'old', status: 'waiting', created_at: old }, { id: 'new', status: 'waiting', created_at: fresh }, { id: 'run', status: 'active', created_at: old }],
      payment_plan_installments: [{ id: 'o1', plan_id: 'old' }, { id: 'n1', plan_id: 'new' }, { id: 'r1', plan_id: 'run' }],
    });
    const n = await ops.dropStaleWaitingPlans(db, new Date('2026-11-06T16:00:00Z'));
    swept = { n, plans: db.tables.payment_plans.map(p => p.id).join(','), insts: db.tables.payment_plan_installments.map(i => i.id).join(',') };
  } catch (e) { swept = e.message; }
  check('a plan still waiting after 7 days is deleted with its payments', swept?.n === 1 && swept?.plans === 'new,run' && swept?.insts === 'n1,r1', short(swept));
  const pp = read('supabase/functions/payment_plans/index.ts');
  check('the daily run sweeps them', /dropStaleWaitingPlans\(/.test(block(pp, "if (action === 'cron_run')", 8000)));
  check('Money → Plans leaves waiting plans out', /neq\('status', 'waiting'\)/.test(block(pp, "if (action === 'list_plans')", 500)));
  check('so does the family\'s own plan in the app', /neq\('status', 'waiting'\)/.test(block(read('supabase/functions/_shared/plan_ops.ts'), 'export async function memberPlanView', 500)));
  // Everything else that counts or charges plans reads active ones by name.
  const counts = ['supabase/functions/_shared/board_home.ts', 'supabase/functions/_shared/membership_status.ts', 'supabase/functions/payments_admin/index.ts', 'supabase/functions/households_admin/index.ts'];
  check('the board home, the member check and the money screens count active plans only', counts.every(f => /\.(eq|in)\('status', (\[)?'active'/.test(read(f))));
}

if (LIVE) {
  console.log('\nLive (Bishop, temporary family, test card)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-s/1.0' },
      body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const b64 = b => Buffer.from(b).toString('base64url');
  const jwt = p => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 900 })); return `${h}.${body}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`; };
  const fn = async (name, body, token, extra = {}) => {
    const r = await fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' limit 1`);
  const admTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const FAMILY = `SimTest Approve ${String(Date.now()).slice(-6)}`;
  let planId = null;
  try {
    const m = await makeTempMember(sql, club.id, FAMILY);
    const day = n => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
    const [plan] = await sql(`insert into payment_plans (tenant_id, household_id, family_name, plan_type, status, total_cents, today_cents, stripe_customer_id, stripe_payment_method_id)
      values ('${club.id}', '${m.household_id}', '${FAMILY}', 'flex', 'active', 60000, 15000, 'sim_cus_test', 'sim_pm_test') returning id`);
    planId = plan.id;
    await sql(`insert into payment_plan_installments (plan_id, tenant_id, sequence, due_date, amount_cents, status, paid_at, last_attempt_at, stripe_payment_intent_id) values
      ('${planId}', '${club.id}', 1, '${day(-5)}', 15000, 'paid', now() - interval '5 days', now() - interval '5 days', 'sim_pi_auto'),
      ('${planId}', '${club.id}', 2, '${day(2)}', 5500, 'pending', null, null, null),
      ('${planId}', '${club.id}', 3, '${day(33)}', 5500, 'pending', null, null, null)`);

    const up = await fn('payment_plans', { action: 'upcoming' }, admTok);
    const mine = (up.upcoming || []).filter(u => u.plan_id === planId);
    check('S4: the next 30 days list the family\'s payment, not the one after', up.ok && mine.length === 1 && mine[0].amount_cents === 5500 && !mine[0].approved_at, short({ ok: up.ok, mine }));
    check('S4: with the short line: total, down payment, monthly', mine[0]?.plan_total_cents === 60000 && mine[0]?.down_cents === 15000 && mine[0]?.monthly_cents === 5500, short(mine[0]));
    check('S4: and the last 30 days of automatic charges', (up.history || []).some(h => h.family_name === FAMILY && h.status === 'paid'), short((up.history || []).slice(0, 3)));

    const ask = await fn('payment_plans', { action: 'approval_ask_run', only_tenant: club.id }, null, { 'x-cron-secret': env.CRON_SECRET });
    const t1 = await sql(`select id, summary from admin_tasks where tenant_id = '${club.id}' and kind = 'payments.approve_due' and completed_at is null`);
    check('S3: 3 days out, the Treasurer gets a task to approve', ask.ok && t1.length === 1, short({ ask, t1 }));

    const ap = await fn('payment_plans', { action: 'approve', ids: [mine[0]?.id] }, admTok);
    const [row] = await sql(`select approved_at, approved_by from payment_plan_installments where id = '${mine[0]?.id}'`);
    const t2 = await sql(`select id from admin_tasks where tenant_id = '${club.id}' and kind = 'payments.approve_due' and completed_at is null`);
    check('S4: ticking it approves it, and the task closes when nothing waits', ap.ok && !!row.approved_at && row.approved_by === owner.id && t2.length === 0, short({ ap, row, open: t2.length }));
    const un = await fn('payment_plans', { action: 'unapprove', id: mine[0]?.id }, admTok);
    const [row2] = await sql(`select approved_at from payment_plan_installments where id = '${mine[0]?.id}'`);
    check('S4: and it can be undone before it\'s charged', un.ok && !row2.approved_at, short({ un, row2 }));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    if (planId) await sql(`delete from payment_plan_installments where plan_id = '${planId}'; delete from payment_plans where id = '${planId}'`);
    await sql(`delete from admin_tasks where tenant_id = '${club.id}' and kind = 'payments.approve_due'`);
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    const [{ left }] = await sql(`select count(*)::int as left from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%'`);
    check('cleanup: the temporary family and plan are gone', left === 0, String(left));
  }
}

// PLAN.md CH (Doug 11/7): "I have a notification for giving a keyfob but it goes to the payments…. Then I go to keyfobs and nothing is there".
console.log('\nCH · the "key fobs can be turned on" to-do');
{
  const ops = await importTs(new URL('../supabase/functions/_shared/plan_ops.ts', import.meta.url));
  const base = { family: 'Frevele Family', back: false, why: 'paid half their dues', activeFobs: 1, autoSync: false, seasonOpen: true };
  check('CH1: no keyfob, no to-do (their app Unlock already works)', typeof ops.fobOnTask === 'function' && ops.fobOnTask({ ...base, activeFobs: 0 }) === null);
  check('CH1: off-season, or with the nightly sync on, no to-do', typeof ops.fobOnTask === 'function' && ops.fobOnTask({ ...base, seasonOpen: false }) === null && ops.fobOnTask({ ...base, autoSync: true }) === null);
  const t = typeof ops.fobOnTask === 'function' ? ops.fobOnTask(base) : null;
  check('CH1: with a keyfob: "tap Sync keyfobs now", opening Keyfobs & Access', !!t && t.link_url === '/club/admin/keyfobs.html' && /Sync keyfobs now/.test(t.summary) && /their keyfob/.test(t.summary) && /paid half their dues/.test(t.summary), JSON.stringify(t));
  const t2 = typeof ops.fobOnTask === 'function' ? ops.fobOnTask({ ...base, back: true, activeFobs: 2 }) : null;
  check('CH1: paid up again, two keyfobs', !!t2 && /paid up again/.test(t2.summary) && /their 2 keyfobs back on/.test(t2.summary), JSON.stringify(t2));
  const src = readFileSync(new URL('../supabase/functions/_shared/plan_ops.ts', import.meta.url), 'utf8');
  const grant = src.slice(src.indexOf('export async function grantAccessIfReady'), src.indexOf('export async function completeIfPaid'));
  check('CH1: grantAccessIfReady counts the family\'s keyfobs and uses fobOnTask, never Payments', /fobOnTask\(/.test(grant) && /fobState\(|from\('keyfobs'\)/.test(grant) && !/payments\.html#plans/.test(grant));
  // CI1: the same when a plan ends.
  const off = { family: 'Smith Family', activeFobs: 1, autoSync: false, seasonOpen: true };
  check('CI1: a plan ending: no keyfob, off-season or nightly sync on, no to-do', typeof ops.fobOffTask === 'function'
    && ops.fobOffTask({ ...off, activeFobs: 0 }) === null && ops.fobOffTask({ ...off, seasonOpen: false }) === null && ops.fobOffTask({ ...off, autoSync: true }) === null);
  const o = typeof ops.fobOffTask === 'function' ? ops.fobOffTask(off) : null;
  check('CI1: with a keyfob: "tap Sync keyfobs now to turn their keyfob off", opening Keyfobs & Access', !!o && o.link_url === '/club/admin/keyfobs.html' && /Sync keyfobs now/.test(o.summary) && /their keyfob off/.test(o.summary), JSON.stringify(o));
  const enforce = src.slice(src.indexOf('export async function enforceEnd'), src.indexOf('export type EndReason'));
  check('CI1: enforceEnd uses it, never Payments', /fobOffTask\(/.test(enforce) && !/payments\.html#plans/.test(enforce), enforce.slice(-400));
  const pay = readFileSync(new URL('../club/admin/payments.html', import.meta.url), 'utf8');
  check('CI2: no position named in the plan-ended email or the plan options (alerts go by the Board page\'s ticks)',
    !/Facilities Director/.test(src.slice(src.indexOf('async function emailTreasurer'))) && !/Facilities Director|the Treasurer gets/.test(pay.slice(pay.indexOf('id="plan-deactivate"') - 200, pay.indexOf('id="plan-deactivate"') + 700)));
}

// PLAN.md CJ (Doug 11/7): "Only cancel or turn off keyfob if they miss a deadline", "if someone on a payment plan misses a payment we should be notified right away".
console.log('\nCJ · only a missed deadline cancels; a failed payment tells the board');
{
  const ops = await importTs(new URL('../supabase/functions/_shared/plan_ops.ts', import.meta.url));
  const P = await importTs(new URL('../supabase/functions/_shared/positions.ts', import.meta.url));
  const ms = [{ date: '2027-04-10', pct: 75 }, { date: '2027-07-01', pct: 100 }];
  const row = (seq, due, status, approved = true) => ({ sequence: seq, due_date: due, status, approved_at: approved ? '2027-01-01T00:00:00Z' : null, amount_cents: 10000 });
  const fn = typeof ops.missedDeadline === 'function' ? ops.missedDeadline : () => 'missing';
  check('CJ1: the first deadline counts: a payment due by it, unpaid after it, is a missed deadline', fn([row(1, '2027-03-01', 'paid'), row(2, '2027-04-01', 'failed'), row(3, '2027-06-01', 'pending')], ms, '2027-04-11') === '2027-04-10');
  check('CJ1: …not before it has passed', fn([row(1, '2027-03-01', 'paid'), row(2, '2027-04-01', 'retrying')], ms, '2027-04-10') === null);
  check('CJ1: …not when everything due by it is paid (a later failure waits for the next deadline)', fn([row(1, '2027-03-01', 'paid'), row(2, '2027-04-01', 'paid'), row(3, '2027-05-01', 'failed')], ms, '2027-05-20') === null);
  check('CJ1: the paid-in-full date counts too', fn([row(1, '2027-03-01', 'paid'), row(2, '2027-06-01', 'retrying')], ms, '2027-07-02') === '2027-07-01');
  check('CJ1: never over a payment the board hadn\'t approved', fn([row(1, '2027-03-01', 'paid'), row(2, '2027-04-01', 'pending', false)], ms, '2027-04-20') === null);
  const ft = typeof ops.failedPaymentTask === 'function' ? ops.failedPaymentTask : null;
  const f1 = ft && ft({ family: 'Smith Family', amount: '$100.00', sequence: 2, exhausted: false, error: 'Your card was declined.', nextTry: 'Nov 10', deadline: 'April 10' });
  check('CJ3: first decline: whose, how much, why, the next try and the next deadline', !!f1 && /Smith Family/.test(f1.summary) && /\$100\.00/.test(f1.summary) && /declined/i.test(f1.summary) && /Nov 10/.test(f1.summary) && /April 10/.test(f1.summary) && !/cancel/i.test(f1.summary.replace(/cancell?ed (only )?if/i, '')), JSON.stringify(f1));
  const f2 = ft && ft({ family: 'Smith Family', amount: '$100.00', sequence: 2, exhausted: true, error: 'Your card was declined.', nextTry: null, deadline: 'April 10' });
  check('CJ3: after the last try: still hasn\'t gone through, keyfob stays on until the deadline', !!f2 && /still hasn.t gone through/i.test(f2.summary) && /April 10/.test(f2.summary), JSON.stringify(f2));
  check('CJ3: it\'s a payments alert', P.TASK_NOTICE['plan.payment_failed'] === 'payments');
  const pp = read('supabase/functions/payment_plans/index.ts'), po = read('supabase/functions/_shared/plan_ops.ts'), wh = read('supabase/functions/stripe_webhook/index.ts');
  const loop = pp.slice(pp.indexOf('const due = chargeableNow('), pp.indexOf('// 1b.'));
  check('CJ2: the daily run never ends a plan for a card', !/endPlan\(sb, club, plan, 'card_failed'\)/.test(pp), loop.slice(0, 300));
  const dl = pp.slice(pp.indexOf('// 2. '), pp.indexOf('past_deadline++') + 20);
  check('CJ1: the daily run checks every deadline', /missedDeadline\(/.test(dl) && /endPlan\(sb, club, plan, 'deadline'\)/.test(dl), dl.slice(0, 300));
  const charge = pp.slice(pp.indexOf('async function chargeInstallment'), pp.indexOf('async function sendReceipt'));
  check('CJ3: the first decline and the last try tell the board', /failedPaymentNotice\(/.test(charge) && /attempts === 1 \|\| exhausted/.test(charge));
  check('CJ3: a payment that goes through clears it, from the daily run and from the family paying in the app', /clearFailedPayment\(/.test(pp) && /clearFailedPayment\(/.test(wh));
  const end = po.slice(po.indexOf('export async function endPlan'), po.indexOf('async function emailTreasurer'));
  check('CJ4: Cancel plan turns access off at once', /if \([^\n]*reason === 'member_cancelled'[^\n]*\) await enforceEnd\(/.test(end), end.slice(0, 500));
  const tpl = read('supabase/functions/_shared/email_template.ts'), app = read('m/index.html'), help = read('club/admin/help/articles/payment-plans.md'), pay = read('club/admin/payments.html');
  check('CJ wording: no "can\'t be charged, your membership is canceled" left for families, the board or the help',
    !/still can't be charged, your membership is canceled/.test(tpl) && !/card kept failing, it wasn/.test(tpl) && !/fails a fourth time/.test(help) && !/A card that keeps failing, or a plan not paid in full by your last deadline, cancels/.test(pay)
    && /next_deadline/.test(tpl) && /missed deadline|miss(es)? a (payment )?deadline/i.test(help));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

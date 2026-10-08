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
  check('a plan doesn\'t end over a payment the board hadn\'t approved', /awaitingApproval|!r\.approved_at|approved_at/.test(cron.slice(cron.indexOf('paid-in-full date'))));
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

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

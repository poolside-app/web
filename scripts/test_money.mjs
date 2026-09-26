#!/usr/bin/env node
// Targeted check for plans, discounts, referrals and codes (PLAN.md H4–H7).
// Offline checks cost nothing. The live part runs against Bishop in test
// mode with a temporary family it removes afterward.
//
// Usage: node scripts/test_money.mjs [--offline]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const between = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, to ? src.indexOf(to, i + from.length) : undefined); };
const OFFLINE = process.argv.includes('--offline');

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const short = o => String(JSON.stringify(o)).slice(0, 240);
const env = Object.fromEntries(read('.env.local')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-money/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const b64url = b => Buffer.from(b).toString('base64url');
function jwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
}
async function fn(name, action, token, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// ── H4: plan deadlines across New Year ───────────────────────────────────
console.log('H4 · payment plan deadlines (offline)');
{
  const ps = await importTs(new URL('supabase/functions/_shared/payment_schedule.ts', root));
  // "50% by December 1, the rest by May 1", for the 2027 season, with next
  // season going on sale in December.
  const plan = { enabled: true, milestones: [{ date: '05-01', min_pct: 100, label: 'Paid in full' }, { date: '12-01', min_pct: 50 }] };
  const rules = ps.resolveRules(plan, 2027, 12);
  check('H4: a December deadline falls in the year before the season',
    short(rules.milestones.map(m => [m.date, m.min_pct])) === short([['2026-12-01', 50], ['2027-05-01', 100]]), short(rules.milestones));

  // Joining on December 15, after the December deadline: the share that was
  // due by then is due now, so a plan can still be made.
  const gen = ps.generateSchedule({ totalCents: 60000, rules, count: 4, startDate: '2026-12-15' });
  check('H4: joining after a deadline puts its share in the first payment',
    gen.ok && gen.installments[0].due_date === '2026-12-15' && gen.installments[0].amount_cents >= 30000
      && gen.installments.at(-1).due_date === '2027-05-01'
      && gen.installments.reduce((n, i) => n + i.amount_cents, 0) === 60000, short(gen));
  const v = gen.ok && ps.validateSchedule({ installments: gen.installments, rules, totalCents: 60000, startDate: '2026-12-15' });
  check('H4: and the server accepts that schedule', v && v.ok, short(v));

  const terms = ps.twoPaymentTerms && ps.twoPaymentTerms(plan, 2027, 12);
  check('H4: the signup form\'s pay-in-two uses the season\'s dates',
    terms && terms.first_pct === 50 && terms.final_due_date === '2027-05-01', short(terms));

  check('H4: keyfobs aren\'t switched off over a fall deadline',
    ps.enforcementDate(plan, 2027, 12) === '2027-05-01', ps.enforcementDate(plan, 2027, 12));

  // Same-year plans keep working.
  const summer = ps.resolveRules({ milestones: [{ date: '04-01', min_pct: 75 }, { date: '07-01', min_pct: 100 }] }, 2027, 12);
  check('H4: a spring-and-summer plan is unchanged',
    short(summer.milestones.map(m => m.date)) === short(['2027-04-01', '2027-07-01']), short(summer.milestones));

  // The board screen: sorted by season, and the last one is "the rest".
  const page = read('club/admin/payments.html');
  const src = between(page, '// ── Payment deadlines (milestones)', '// ── Setup: Payment plans');
  const box = { document: { getElementById: id => ({ checked: id === 'plan-enabled' }) }, console };
  vm.createContext(box);
  try {
    vm.runInContext(src.replace(/\blet MILESTONES\b/, 'var MILESTONES').replace(/\blet OPENS_MONTH\b/, 'var OPENS_MONTH'), box);
    vm.runInContext(`MILESTONES = [{ date: '05-01', min_pct: 1, label: '' }, { date: '12-01', min_pct: 50, label: '' }]; OPENS_MONTH = 12;`, box);
    const problem = vm.runInContext('milestoneProblem()', box);
    const order = vm.runInContext('seasonSorted(MILESTONES).map(m => m.date + ":" + m.min_pct).join(",")', box);
    check('H4: the board can save "50% by Dec 1, the rest by May 1"',
      problem === '' && order === '12-01:50,05-01:100', `${problem} | ${order}`);
    check('H4: the last deadline has no % box; it says "the rest"',
      /The rest \(100%\)/.test(src) && /isLast/.test(src), 'no "The rest (100%)" row');
  } catch (e) {
    check('H4: the board can save "50% by Dec 1, the rest by May 1"', false, e.message);
  }
  const apply = read('apply.html');
  check('H4: the signup form hides pay-in-two once its last deadline has passed',
    /plan\.final_due_date > today/.test(apply), 'no final_due_date check');
}

// ── Live ─────────────────────────────────────────────────────────────────
if (!OFFLINE) {
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const [{ plan: savedPlan }] = await sql(`select value->'payments'->'plan' as plan from settings where tenant_id = '${club.id}'`);

  console.log('\nH4 · live (3 calls; puts Bishop\'s plan settings back afterward)');
  try {
    const saved = await fn('payment_plans', 'config_save', ownerTok, { config: {
      enabled: true, milestones: [{ date: '12-01', min_pct: 50, label: '' }, { date: '05-01', min_pct: 100, label: 'Paid in full' }],
    } });
    check('H4: the server saves "50% by Dec 1, the rest by May 1"', saved.ok, short(saved));
    const pub = await fn('tenant_public', undefined, null, { slug: 'bishopestates' });
    const [{ opens, pinned }] = await sql(`select value->'membership'->>'renewal_opens_month' as opens, value->'membership'->>'year' as pinned from settings where tenant_id = '${club.id}'`);
    const now = new Date(), month = now.getUTCMonth() + 1, opensM = Number(opens) || 12;
    const year = Number(pinned) > 2000 ? Number(pinned) : (month >= opensM ? now.getUTCFullYear() + 1 : now.getUTCFullYear());
    const pp = pub.public_settings?.payment_plan;
    check(`H4: the signup form gets 50% now, the rest on May 1, ${year}`,
      pp && pp.enabled && pp.first_installment_pct === 50 && pp.final_due_date === `${year}-05-01`, short(pp));
  } finally {
    await sql(savedPlan == null
      ? `update settings set value = value #- '{payments,plan}' where tenant_id = '${club.id}'`
      : `update settings set value = jsonb_set(value, '{payments,plan}', '${JSON.stringify(savedPlan).replace(/'/g, "''")}'::jsonb) where tenant_id = '${club.id}'`);
    const [{ plan }] = await sql(`select value->'payments'->'plan' as plan from settings where tenant_id = '${club.id}'`);
    check('H4: Bishop\'s plan settings are back as they were', JSON.stringify(plan) === JSON.stringify(savedPlan), short(plan));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

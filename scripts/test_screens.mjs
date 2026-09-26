#!/usr/bin/env node
// Targeted check for the friendlier-screens list (PLAN.md D1–D13).
// Offline checks read the pages and helpers and cost nothing. `--live` adds
// the server parts (about 4 Edge Function calls, with a temporary family),
// and `--render` opens the changed pages in headless Chrome at phone size
// (about 15 calls; it serves this checkout's copies of the pages).
//
// Usage: node scripts/test_screens.mjs [--live] [--render]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import vm from 'node:vm';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const env = Object.fromEntries(read('.env.local')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const between = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, to ? src.indexOf(to, i + from.length) : undefined); };

const apply = read('apply.html');
const member = read('m/index.html');
const login = read('m/login.html');
const dash = read('club/admin/index.html');
const members = read('club/admin/members.html');
const gate = read('supabase/functions/gate_admin/index.ts');

console.log('D1 · signup form errors show once');
{
  const show = between(apply, 'function show(msg)', '\n}');
  check('a step error is shown in one place, next to the button', !!show && !/err-top/.test(show) && /getElementById\('err'\)/.test(show));
  check('a field error is shown under that field', /field-err/.test(between(apply, 'function showField', '\n}')));
}

console.log('\nD2 · the Venmo wait matches the club\'s setting');
{
  const done = between(apply, "document.getElementById('form').className = 'card ok';", '</p>');
  check('no fixed "1–10 days"', !/1–10 days/.test(apply));
  check('the thank-you uses offline_verify_window_days', /offline_verify_window_days/.test(between(apply, 'async function submitApplication', 'function simulateVenmo')) || /verifyDays/.test(done));
}

console.log('\nD3 · a new member isn\'t welcomed "back"');
check('first visit says Welcome to…, later visits Welcome back', /poolside_welcomed_/.test(member) && /Welcome to\b/.test(member));

console.log('\nD4 · no browser pop-ups in the member app');
{
  const code = member.replace(/\/\/.*$/gm, '');
  const pops = (code.match(/(^|[^.\w])(alert|confirm|prompt)\(/g) || []).length;
  check('no alert(), confirm() or prompt() left', pops === 0, `${pops} left`);
  check('sign-ups pick from your family', /function pickFamilyMember/.test(member) && /pickFamilyMember\(/.test(between(member, 'async function bookProgram', '\n}'))
    && /pickFamilyMember\(/.test(between(member, 'async function volunteerSignup', '\n}')));
  check('messages and confirmations are in-page', /function notify\(/.test(member) && /askConfirm\s*=|function askConfirm\(/.test(member));
}

console.log('\nD5 · card payment only when Stripe can charge');
check('the card options need stripe_charges_enabled (or test mode)', /stripe_charges_enabled\s*\|\|\s*testMode/.test(apply) || /testMode\s*\|\|[^\n]*stripe_charges_enabled/.test(apply));
check('the wrong "we\'ll email you a payment link" note is gone', !/email you a payment link/.test(apply) && !/stripe-hint/.test(apply));

console.log('\nD6 · sign-in can be resent, and email says check spam');
check('after sending, the button offers Send it again', /Send it again/.test(login));
check('the email path mentions spam', /spam/i.test(login));

console.log('\nD7 · test payments are tagged in Members');
check('households list marks test-paid families', /test_paid/.test(read('supabase/functions/households_admin/index.ts')) && /🧪 Test/.test(members));

console.log('\nD8 · family and dues near the top of the member home');
{
  const start = member.indexOf('${renderSponsorStrip(publicData.sponsors');
  const tpl = start < 0 ? '' : member.slice(start, start + 9000);
  const fam = tpl.indexOf('/m/family.html'), today = tpl.indexOf('today-block');
  check('the family card comes before Today and the photos', fam > 0 && today > 0 && fam < today, `family at ${fam}, today at ${today}`);
}

console.log('\nD9 · "Coming up" includes calendar-feed events');
try {
  const sandbox = { globalThis: {}, window: undefined };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('js/upcoming.js'), sandbox);
  const U = sandbox.PoolsideUpcoming;
  const now = Date.parse('2026-06-01T15:00:00Z');
  const day = d => new Date(now + d * 86400000);
  const at = (d, h) => { const x = day(d); x.setUTCHours(h, 0, 0, 0); return x.toISOString(); };
  const feeds = [{ id: 'f1', label: 'Google', events: [
    ...Array.from({ length: 30 }, (_, i) => ({ uid: 'pool-open', summary: 'Pool Open', starts_at: at(i, 14), ends_at: at(i, 27) })),
    ...[2, 9, 16].map(d => ({ uid: 'swim', summary: 'Swim team practice', starts_at: at(d, 16), ends_at: at(d, 17) })),
    { uid: 'bbq', summary: 'Opening BBQ', starts_at: at(5, 23), ends_at: at(5, 26) },
  ] }];
  const native = [{ id: 'n1', title: 'Board meeting', starts_at: at(3, 2), kind: 'meeting' }];
  const list = U.merge(native, feeds, { now, days: 60, limit: 5 });
  const titles = list.map(e => e.title);
  check('club events and feed events together, soonest first', titles.join(' | ') === 'Swim team practice | Board meeting | Opening BBQ', titles.join(' | '));
  check('a daily "Pool Open" is left out (Today shows the hours)', !titles.includes('Pool Open'));
  check('a weekly event shows only its next date', titles.filter(t => t === 'Swim team practice').length === 1);
  check('the member home and dashboard both use it',
    /PoolsideUpcoming\.merge/.test(member) && /upcoming\.js/.test(member) && /PoolsideUpcoming\.merge/.test(dash) && /upcoming\.js/.test(dash));
} catch (e) {
  check('js/upcoming.js exists', false, e.message.split('\n')[0]);
}

console.log('\nD10 · the money total leaves out test payments');
try {
  const t = await importTs(new URL('supabase/functions/_shared/test_payments.ts', root));
  check('the fake-Venmo note matches what the simulator writes', read('supabase/functions/applications/index.ts').includes(t.SIM_NOTE));
  check('the dues total uses it', /testPaidHouseholds/.test(read('supabase/functions/tenant_admin_auth/index.ts')) && /test_paid/.test(read('js/admin-flags.js')));
} catch (e) {
  check('_shared/test_payments.ts exists', false, e.message.split('\n')[0]);
}

console.log('\nD11 · one gate-offline task per outage');
check('an open gate-offline task is updated, not duplicated', /gate\.bridge_offline/.test(between(gate, 'stage 2', 'stage 3') || gate) && /existingOffline|openOffline/.test(gate));
check('the task clears when the bridge comes back', /bridge_offline[\s\S]{0,300}completed_at/.test(between(gate, 'if (isOnline && state !== \'ok\')', 'results.push({ tenant_id: tenantId, transition: \'recovered\'')));
check('the back-online pop-up doesn\'t use the made-up "operations" label', !/'operations'/.test(gate));

console.log('\nD12 · Members list fits a phone');
check('the households table becomes cards on narrow screens', /data-label=/.test(members) && /@media \(max-width: ?\d+px\)[\s\S]{0,400}#hh-card/.test(members));
check('the Help button no longer covers the bottom of admin pages', /padding-bottom/.test(read('js/admin-help-fab.js')));

console.log('\nD13 · sign-in box fits, and the button says what it will do');
{
  const ph = (login.match(/id="email"[^>]*placeholder="([^"]+)"/) || [])[1] || '';
  check('the placeholder is short enough for a phone', ph.length > 0 && ph.length <= 24, `"${ph}"`);
  check('the button says Text me a code or Email me a link', /Text me a code/.test(login) && /Email me a link/.test(login));
  const aph = (read('club/admin/login.html').match(/placeholder="([^"]*@[^"]*)"/) || [])[1] || '';
  check('the board sign-in placeholder fits too', !aph || aph.length <= 24, `"${aph}"`);
}

console.log('\nG1 · no Sign in with Google anywhere (Doug, 2026-09-25)');
{
  const { readdirSync, statSync, existsSync } = await import('node:fs');
  const walk = dir => readdirSync(new URL(dir, root)).flatMap(n => {
    const rel = `${dir}${n}`;
    if (n === 'node_modules' || n.startsWith('.')) return [];
    return statSync(new URL(rel, root)).isDirectory() ? walk(rel + '/') : /\.html$/.test(n) ? [rel] : [];
  });
  const pages = walk('');
  const hits = pages.filter(p => /Sign (in|up) with Google|google-sign(in|up)|google_oauth|prefill=google|google_sub/i.test(read(p)));
  check('no page offers or handles Google sign-in', !hits.length, hits.join(', '));
  check('the Google sign-in server code is gone',
    !existsSync(new URL('supabase/functions/google_oauth', root)) && !/google_oauth/.test(read('supabase/config.toml'))
    && !/signin\/callback/.test(read('vercel.json')) && !/google_sub/.test(read('supabase/functions/tenant_signup/index.ts')));
  check('Drive backup keeps its own Google connection', /drive\/callback/.test(read('vercel.json'))
    && existsSync(new URL('supabase/functions/google_drive_sync/index.ts', root)));
  const ph = (login.match(/id="email"[^>]*placeholder="([^"]+)"/) || [])[1] || '';
  check('member sign-in asks for a cell number first', /^Cell/.test(ph) && /<label for="email">Cell/.test(login), `"${ph}"`);
}

// ── Live ────────────────────────────────────────────────────────────────
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-screens/1.0' },
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
async function fn(name, body, token) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

if (process.argv.includes('--live')) {
  console.log('\nLive, bishopestates (D7, D10)');
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const tok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const FAMILY = `SimTest screens ${String(Date.now()).slice(-6)}`;
  try {
    const before = await fn('tenant_admin_auth', { action: 'me' }, tok);
    const m = await makeTempMember(sql, club.id, FAMILY);   // dues paid
    await sql(`insert into applications (tenant_id, family_name, primary_name, status, payment_status, payment_method, household_id, stripe_session_id, primary_email, primary_phone)
      values ('${club.id}', '${FAMILY}', '${FAMILY} Tester', 'approved', 'paid', 'stripe', '${m.household_id}', 'sim_cs_${Date.now()}', 'doug.frevele+simtest@gmail.com', '+15550100000')`);
    const after = await fn('tenant_admin_auth', { action: 'me' }, tok);
    const b = before.usage?.dues ?? {}, a = after.usage?.dues ?? {};
    check('a test-paid family isn\'t counted as money collected', a.collected_cents === b.collected_cents && a.paid === b.paid,
      `before ${JSON.stringify(b)} after ${JSON.stringify(a)}`);
    check('…it\'s counted separately as a test', (a.test_paid ?? 0) === (b.test_paid ?? 0) + 1, JSON.stringify(a));
    const list = await fn('households_admin', { action: 'list' }, tok);
    const hh = (list.households || []).find(h => h.id === m.household_id);
    check('the Members list marks it as a test payment', hh?.test_paid === true, JSON.stringify(hh ?? {}).slice(0, 120));
  } finally {
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
  }
}

if (process.argv.includes('--live')) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/google_oauth?action=status`);
  check('G1: the Google sign-in function is no longer deployed', r.status === 404, `status ${r.status}`);
  const [{ n }] = await sql(`select count(*)::int as n from information_schema.columns
    where table_schema = 'public' and column_name = 'google_sub'`);
  check('G1: no stored Google IDs left', n === 0, `${n} columns`);
}

if (process.argv.includes('--render')) {
  const { renderChecks } = await import('./lib/screens_render.mjs');
  await renderChecks({ check, read, sql, jwt, env });
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

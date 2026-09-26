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
{
  const start = between(login, 'async function doStart', '// ── 6-digit code sign-in');
  check('a phone number always gets the code box, on file or not', /idKind\(raw\) === 'phone'/.test(start) && /code-box/.test(start));
  check('the reply offers "Not a member yet? Join"', /Not a member yet/.test(start) && /\/apply\.html/.test(start));
}

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

console.log('\nH1–H3 · signup name, level by headcount, sign-in phone format');
check('H1: page 1 asks "Your name" and it fills Adult #1', /id="your_name"/.test(apply)
  && /your_name/.test(between(apply, 'function prefillPrimaryAdult', '\n}')));
check('H1: "Your name" is required on page 1', /getElementById\('your_name'\)/.test(between(apply, 'function _goNext', 'function show(')) && /showField\(you,/.test(apply));
check('H2: the level is picked by headcount unless they chose one', /function applyTierDefault/.test(apply) && /TIER_TOUCHED/.test(apply)
  && /applyTierDefault\(\)/.test(between(apply, 'function showStep', '\n}')));
check('H3: member sign-in formats the phone number as you type', /function formatLoginPhone|looksLikePhoneStart/.test(login));

console.log('\nI1–I5 · trimmed features are gone');
{
  const { readdirSync, statSync, existsSync } = await import('node:fs');
  const walk = (dir, ext) => readdirSync(new URL(dir, root)).flatMap(n => {
    const rel = `${dir}${n}`;
    if (['node_modules', 'migrations', 'club-demo', 'Poolside design'].includes(n) || n.startsWith('.')) return [];
    return statSync(new URL(rel, root)).isDirectory() ? walk(rel + '/', ext) : ext.test(n) ? [rel] : [];
  });
  const files = [...walk('', /\.(html|js|ts)$/)].filter(f => !f.startsWith('scripts/'));
  const hits = re => files.filter(f => re.test(read(f)));
  const gone = dir => !existsSync(new URL(`supabase/functions/${dir}`, root)) && !new RegExp(`functions\\.${dir}\\]`).test(read('supabase/config.toml'));
  check('I1: no anonymous feedback anywhere', gone('feedback') && !existsSync(new URL('club/admin/feedback.html', root))
    && !hits(/openFeedback|functions\/v1\/feedback|feedback\.html|feedback\.submitted/).length, hits(/openFeedback|functions\/v1\/feedback|feedback\.html|feedback\.submitted/).join(', '));
  check('I2: no campaign pop-ups anywhere', gone('campaigns') && !existsSync(new URL('club/admin/campaigns.html', root))
    && !hits(/functions\/v1\/campaigns|campaigns\.html|feat_campaigns|camp-count/).length, hits(/functions\/v1\/campaigns|campaigns\.html|feat_campaigns|camp-count/).join(', '));
  const auth = read('supabase/functions/tenant_admin_auth/index.ts');
  check('I3: no Impact page or permission', !existsSync(new URL('club/admin/impact.html', root)) && !hits(/impact\.html/).length
    && !/'impact'/.test(auth) && !/\bimpact:/.test(read('js/admin-flags.js')), hits(/impact\.html/).join(', '));
  check('I4: the member home greeting has no member-count line', !/renderMemberCountTicker/.test(member));
  check('I5: no guest-pass leftovers', gone('guest_passes') && !existsSync(new URL('club/admin/guest-passes.html', root))
    && !hits(/guest_pass|guest-pass|guestPass/).length, hits(/guest_pass|guest-pass|guestPass/).join(', '));
}

console.log('\nJ1–J8 · one place for each setting');
{
  const { existsSync } = await import('node:fs');
  const exists = rel => existsSync(new URL(rel, root));
  const ts = read('supabase/functions/tenant_settings/index.ts');
  const setupBlock = between(ts, "if (action === 'setup_status')", 'return jsonResponse({');
  const ids = [...setupBlock.matchAll(/\bid: '([a-z_]+)'/g)].map(m => m[1]);
  check('J1: one checklist: the wizard, the setup page and the second list are gone',
    !exists('club/wizard.html') && !exists('club/admin/setup.html') && !/onboarding_status/.test(dash)
    && !/setup_wizard_complete/.test(dash) && !/using the pool too/.test(dash), '');
  check('J1: the checklist has the 9 items, each opening the real screen',
    ['logo', 'hero', 'location', 'prices', 'payment', 'policies', 'self_signup', 'invite_board', 'share_link'].every(i => ids.includes(i)) && !ids.includes('wizard'),
    ids.join(','));
  check('J1: the dashboard shows it; other pages just link there', /id="setup-card"|setup-card/.test(dash) && /setup_status/.test(dash)
    && /\/club\/admin\/#setup/.test(read('js/admin-flags.js')));
  check('J2: the Status page is gone', !exists('club/admin/health.html') && !exists('supabase/functions/admin_health'));
  const settings = read('club/admin/settings.html');
  check('J3: phone alerts are on the dashboard only', !/id="push-card"/.test(settings));
  const applyPage = read('club/admin/application.html');
  check('J4: the Apply form page links instead of repeating editors',
    !/g-season-open|g-memberships-frozen/.test(applyPage) && !/em-subject/.test(applyPage) && !/Edit policy/.test(applyPage)
    && /policies\.html/.test(applyPage) && /emails\.html/.test(applyPage) && /settings\.html[^"]*season/.test(applyPage));
  check('J5: Season has "next season goes on sale"', /id="renewal_opens_month"/.test(settings) && /renewal_opens_month/.test(between(settings, 'async function save', '\n}')));
  check('J6: hours per day in Settings, and daily calendar entries hidden', /data-day-hours|id="hours_by_day"/.test(settings)
    && /dailyFixture|isDailyFixture/.test(read('js/upcoming.js')) && /isDailyFixture/.test(read('js/today.js')) && /isDailyFixture/.test(read('js/calendar.js') + member));
  check('J7: one Gate & check-in section, no "coming soon" methods', /Gate &amp; check-in/.test(settings) && !/coming soon/i.test(between(settings, 'const ACCESS_METHODS', '];'))
    && !/id="access-card"/.test(settings));
  const money = read('club/admin/payments.html');
  check('J8: one Money setup page: prices live on Payments; Tiers and early bird moved',
    /id="prices-card"/.test(money) && /membership_tiers/.test(money) && !exists('club/admin/tiers.html')
    && !/early_bird/.test(read('club/admin/members.html')) && !/tiers\.html/.test(read('js/admin-subtabs.js')));
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
  const deployed = await Promise.all(['feedback', 'campaigns', 'guest_passes'].map(async f =>
    [f, (await fetch(`${SUPABASE_URL}/functions/v1/${f}`, { method: 'POST', body: '{}' })).status]));
  check('I: the removed functions are no longer deployed', deployed.every(([, st]) => st === 404), JSON.stringify(deployed));
  const [{ t }] = await sql(`select count(*)::int as t from information_schema.tables where table_schema = 'public'
    and table_name in ('feedback_submissions', 'campaigns', 'guest_pass_packs', 'guest_pass_uses')`);
  check('I: their empty tables are dropped', t === 0, `${t} left`);
}

if (process.argv.includes('--render')) {
  const { renderChecks } = await import('./lib/screens_render.mjs');
  await renderChecks({ check, read, sql, jwt, env });
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

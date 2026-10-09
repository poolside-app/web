#!/usr/bin/env node
// Targeted check for Doug's 10/8 notes (PLAN.md U): quick fixes, the season
// button, the January 1 rule and the member app tabs. Offline checks read the
// helpers and pages and cost nothing. `--live` adds a few Edge Function calls
// on Bishop with a temporary family, removed afterward.
//
// Usage: node scripts/test_season_home.mjs [--live]
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

console.log('U1 · quick fixes (offline)');
{
  check('board messages point to support@, not Doug', !/doug@poolsideapp\.com/.test(read('club/admin/settings.html')));
  const pay = read('club/admin/payments.html');
  const stripeAt = pay.indexOf('Card payments (Stripe)'), venmoAt = pay.indexOf('Venmo &amp; PayPal'), feeAt = pay.indexOf('id="pass_stripe_fee"');
  check('the card-fee checkbox is with Stripe, not Venmo', stripeAt > 0 && feeAt > stripeAt && feeAt < venmoAt, short({ stripeAt, feeAt, venmoAt }));
  check('no "Emails members get" boxes', !/class="email-callout"/.test(pay));
  check('the page says which season it is', /id="season-banner"/.test(pay));
  check('"Families on a payment plan", not "Payment plans" for the list', /Families on a payment plan/.test(pay));
  check('two fixed deadlines with years, no "add a deadline", no signup cutoff',
    /id="ms-first-month"/.test(pay) && /id="ms-final-month"/.test(pay) && /id="ms-first-year"/.test(pay) && !/addMilestone/.test(pay) && !/id="plan-cutoff"/.test(pay));
  check('a late joiner is told they pay enough today', /signs up after/.test(pay));
  check('no "turn on notifications" on a computer (members)', /isComputer/.test(read('js/member-push.js')));
  const home = read('m/index.html');
  check('no "Add to Home Screen" on a computer', /isComputer\(\)/.test(home.slice(home.indexOf('function renderInstallCard'), home.indexOf('function renderInstallCard') + 1500)));
  check('solved board questions go under "Past questions"', /Past questions/.test(home));
  const kf = read('supabase/functions/keyfobs/index.ts');
  const claim = kf.slice(kf.indexOf("action === 'claim_venmo'"), kf.indexOf("action === 'claim_venmo'") + 1500);
  check('"I sent it by Venmo" goes straight to the board to make the fob', /keyfob\.issue/.test(claim) && /'pending_verify'/.test(kf.slice(kf.indexOf("action === 'issue'"), kf.indexOf("action === 'issue'") + 900)));
}

console.log('U2 · seasons (offline)');
{
  const settings = read('club/admin/settings.html');
  check('Settings → Season shows the current season and a close-out button', /id="season-current"/.test(settings) && /closeSeason\(/.test(settings) && !/id="renewal_opens_month"/.test(settings));
  const ts = read('supabase/functions/tenant_settings/index.ts');
  check('the server: season_status and close_season', /action === 'season_status'/.test(ts) && /action === 'close_season'/.test(ts));
  check('a checklist after closing', /season-checklist/.test(settings));
  check('the dues ticker names the season', /season/.test(read('js/admin-flags.js').slice(read('js/admin-flags.js').indexOf('function paintDuesTicker'), read('js/admin-flags.js').indexOf('function paintDuesTicker') + 2200)));
}

console.log('U3 · the January 1 rule (offline)');
{
  const ms = await importTs(new URL('supabase/functions/_shared/membership_status.ts', root));
  const hh = (paidThrough, plan = false) => ({ paid_until_year: paidThrough, on_plan_for_season: plan });
  check('paid for 2027: a member', ms.memberStatus(hh(2027), 2027, '2027-02-01').member === true);
  check('paid for 2026 only, before Jan 1: still a member', ms.memberStatus(hh(2026), 2027, '2026-11-15').member === true);
  check('paid for 2026 only, from Jan 1: not a member, asked to pay', ms.memberStatus(hh(2026), 2027, '2027-01-01').member === false && ms.memberStatus(hh(2026), 2027, '2027-01-01').renew_needed === true);
  check('on a 2027 plan: a member', ms.memberStatus(hh(2026, true), 2027, '2027-03-01').member === true);
  const allowed = ms.UNPAID_CAN_USE;
  check('an unpaid family keeps My family, the calendar, Ask the board and renewing', ['family', 'calendar', 'help', 'renew'].every(f => allowed.includes(f)) && !allowed.includes('photos') && !allowed.includes('gate'));
  const ma = read('supabase/functions/member_auth/index.ts');
  check('the app is told whether they\'re a member', /householdStatus\(/.test(ma) && /access,/.test(ma));
  check('the gate refuses a non-member', /householdStatus\(/.test(read('supabase/functions/unlock_gate/index.ts')));
  check('parties and keyfobs refuse a non-member', /requireCurrentMember|memberStatus\(/.test(ma.slice(ma.indexOf("action === 'request_party'"), ma.indexOf("action === 'request_party'") + 3000)) && /householdStatus\(/.test(read('supabase/functions/keyfobs/index.ts')));
}

console.log('U4/V · the member app (offline)');
{
  const home = read('m/index.html');
  // Doug, 10/9 (PLAN.md V): three tabs; Home in his order; keyfobs only on My family.
  check('three tabs: Home, Ask the board, My family', /data-tab="\$\{id\}"/.test(home) && ['home', 'help', 'family'].every(t => new RegExp(`tab\\('${t}',`).test(home)) && !/tab\('calendar',/.test(home) && !/tab\('photos',/.test(home));
  check('the bar is fixed to the bottom, attached to the page', /document\.body\.insertAdjacentHTML\('beforeend', `\s*<nav class="mtabs"/.test(home) && /\.mtabs \{ position: fixed;[^}]*bottom: 0/.test(home) && !/\.mtabs \{ position: sticky/.test(home));
  const pane = home.slice(home.indexOf('<section data-pane="home">'), home.indexOf('<section data-pane="help"'));
  const order = ['hero-card compact', 'gate-card', 'todo-host', 'Latest news', 'renderFundraiserCard', 'photos-card', 'calendarHtml'].map(k => pane.indexOf(k));
  check('Home: banner, unlock, to-dos, news, fundraiser, photos, calendar', order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), short(order));
  check('the banner has the date, the weather and today', /hero-date/.test(pane) && /id="hero-weather"/.test(pane) && /todayLine/.test(pane) && /\/js\/pool-weather\.js/.test(home) && /api\.open-meteo\.com/.test(read('js/pool-weather.js')));
  check('keyfobs only on My family', !/renderFobCard|keyfob/i.test(pane) && /renderFobCard\(me\.keyfobs\)/.test(home.slice(home.indexOf('<section data-pane="family"'))));
  check('an unpaid family sees "Pay for" and the calendar', /Pay for \$\{/.test(home) && /: calendarHtml\}/.test(pane));
  check('the banner shows the season they\'re a member for', /✓ \$\{escapeHtml\(String\(acc\.season\)\)\} member/.test(home) && /Renew for \$\{escapeHtml\(String\(acc\.season\)\)\} →/.test(home));
  check('closed for the season: a thank-you in place of the hours', /Thanks for a great \$\{poolSeason\} season! We look forward to seeing you next summer\./.test(home) && /closed_message/.test(home));
  check('remote unlock offline is one quiet line', /Remote unlock is offline right now\. Use your keyfob\./.test(home));
}

if (LIVE) {
  console.log('\nLive (Bishop, temporary family)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-u/1.0' },
      body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const b64 = b => Buffer.from(b).toString('base64url');
  const jwt = p => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 900 })); return `${h}.${body}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`; };
  const fn = async (name, body, token) => {
    const r = await fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' limit 1`);
  const admTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const FAMILY = `SimTest Season ${String(Date.now()).slice(-6)}`;
  try {
    const st = await fn('tenant_settings', { action: 'season_status' }, admTok);
    check('U2: the club\'s current season', st.ok && st.season >= 2026 && typeof st.paid === 'number', short(st));
    const m = await makeTempMember(sql, club.id, FAMILY);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, hid: m.household_id, slug: 'bishopestates' });
    await sql(`update households set paid_until_year = ${st.season - 1} where id = '${m.household_id}'`);
    const me = await fn('member_auth', { action: 'me' }, memTok);
    check('U3: the app gets the family\'s access', me.ok && me.access && typeof me.access.member === 'boolean' && me.access.season === st.season, short(me.access));
    await sql(`update households set paid_until_year = ${st.season} where id = '${m.household_id}'`);
    const me2 = await fn('member_auth', { action: 'me' }, memTok);
    check('U3: paid for the season: a member', me2.access?.member === true, short(me2.access));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    const [{ left }] = await sql(`select count(*)::int as left from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%'`);
    check('cleanup: the temporary family is gone', left === 0, String(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

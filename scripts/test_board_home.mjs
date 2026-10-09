#!/usr/bin/env node
// Targeted check for the board home, one per board member (PLAN.md W).
// Offline checks read the rules and pages and cost nothing. `--live` adds a
// few Edge Function calls on Bishop with temporary board logins, removed
// afterward.
//
// Usage: node scripts/test_board_home.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempAdmin, purgeTempAdmins } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 260);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Bishop's positions as the President ticked them (Settings → Board, 10/9).
const POS = {
  president:  { scopes: [], full: true },
  treasurer:  { scopes: ['payments', 'applications', 'households', 'renewals', 'tiers', 'audit'] },
  secretary:  { scopes: ['meetings', 'policies', 'announcements', 'directory'] },
  facilities: { scopes: ['check_in', 'shifts', 'keyfobs'] },
  grounds:    { scopes: [] },
  membership: { scopes: ['households', 'renewals', 'announcements', 'photos', 'directory'] },
  events:     { scopes: ['events', 'parties', 'programs', 'volunteer'] },
};
const FEATURES = { keyfobs: true, gate: true, lifeguard_scheduling: false };
// A login holding these positions, the way syncLogins sets it up.
const caller = (...names) => ({
  id: 'x', isOwner: names.some(n => POS[n].full),
  scopes: [...new Set(names.flatMap(n => POS[n].scopes))],
});
const held = (...names) => names.map(n => ({ scopes: POS[n].scopes }));

console.log('W1 · each board member\'s home comes from the ticks (offline)');
let bh = null;
try { bh = await importTs(new URL('supabase/functions/_shared/board_home.ts', root)); } catch (e) { check('the rules live in _shared/board_home.ts', false, e.message); }
if (bh) {
  const stats = (...n) => bh.pickStats(caller(...n), held(...n), FEATURES);
  const quick = (...n) => bh.pickQuick(caller(...n), held(...n), FEATURES);
  check('President: families paid, collected, on a plan', same(stats('president'), ['paid', 'collected', 'on_plan']), short(stats('president')));
  check('President: Text all members, Post news, Add an event, Add photos', same(quick('president'), ['text_all', 'post_news', 'add_event', 'add_photos']), short(quick('president')));
  check('Treasurer: collected, still owed, on a plan', same(stats('treasurer'), ['collected', 'owed', 'on_plan']), short(stats('treasurer')));
  check('Treasurer: Upcoming payments and Payments first', same(quick('treasurer').slice(0, 2), ['upcoming', 'payments']), short(quick('treasurer')));
  check('Facilities Director: check-ins, keyfobs to make, keyfobs in use', same(stats('facilities'), ['checkins', 'fobs_to_make', 'fobs_in_use']), short(stats('facilities')));
  check('Facilities Director: Keyfobs and Check-in buttons', quick('facilities').slice(0, 2).every(k => ['keyfobs', 'checkin'].includes(k)), short(quick('facilities')));
  const noFobs = bh.pickStats(caller('facilities'), held('facilities'), { ...FEATURES, keyfobs: false });
  check('no keyfob numbers or buttons when the club has keyfobs off', !noFobs.some(k => /fob/.test(k)) && !bh.pickQuick(caller('facilities'), held('facilities'), { ...FEATURES, keyfobs: false }).includes('keyfobs'), short(noFobs));
  check('Events & Rentals: parties and events this week, programs', same(stats('events'), ['parties_week', 'events_week', 'programs']), short(stats('events')));
  check('Secretary: Text all members and Post news first', same(quick('secretary').slice(0, 2), ['text_all', 'post_news']), short(quick('secretary')));
  check('Grounds (no screens): member questions, next meeting, families paid', same(stats('grounds'), ['questions', 'next_meeting', 'paid']), short(stats('grounds')));
  check('Grounds: Member help and Add to the agenda', same(quick('grounds').slice(0, 2), ['member_help', 'agenda']), short(quick('grounds')));
  check('Membership: families paid and renewals, then photos', same(stats('membership'), ['paid', 'renewals_left', 'photos_waiting']), short(stats('membership')));
  const both = stats('treasurer', 'facilities');
  check('two positions: numbers from both', both.includes('collected') && both.includes('checkins'), short(both));
  check('always three numbers and four buttons', Object.keys(POS).every(n => stats(n).length === 3 && quick(n).length === 4));
  check('every button opens a screen the person can use',
    Object.keys(POS).every(n => quick(n).every(k => { const q = bh.QUICK.find(x => x.key === k); return q && (!q.needs.length || q.needs.some(s => caller(n).scopes.includes(s)) || caller(n).isOwner); })));
  check('the signup link only for those who handle signups', bh.showSignupLink(caller('president')) && bh.showSignupLink(caller('treasurer')) && !bh.showSignupLink(caller('facilities')) && !bh.showSignupLink(caller('grounds')));
}
{
  const at = read('supabase/functions/admin_tasks/index.ts');
  check('one server call for the home (admin_tasks home)', /action === 'home'/.test(at) && /loadHome\(/.test(at));
  const page = read('club/admin/index.html');
  const order = ['class="hero"', 'id="gate-card"', '<h2>Needs you</h2>', '<h2>Today at the pool</h2>', '<h2>Quick actions</h2>'].map(k => page.indexOf(k));
  check('the page: banner, gate, Needs you, today, quick actions', order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), short(order));
  check('the page asks for the home in one call', /action: 'home'/.test(page) && !/action: 'needs_attention'|status: 'needs_attention'/.test(page) && !/HH_URL/.test(page));
  check('no more "What needs your attention", "Your tasks" or the Club stats box', !/What needs your attention/.test(page) && !/<h2>Your tasks<\/h2>/.test(page) && !/id="hh-count"/.test(page));
  check('the weather at the pool on the banner', /PoolWeather\.load\(/.test(page) && /api\.open-meteo\.com/.test(read('js/pool-weather.js')) && /\/js\/pool-weather\.js/.test(read('m/index.html')));
  check('today and coming up use the shared calendar rules', /PoolsideToday\.items\(/.test(page) && /items: /.test(read('js/today.js')));
  check('each quick button opens its form', /location\.hash === '#text'\) openBlast\(\)/.test(read('club/admin/announcements.html')) && /location\.hash === '#new'\) openCreate\(\)/.test(read('club/admin/announcements.html'))
    && /location\.hash === '#new'\) openCreate\(\)/.test(read('club/admin/events.html')) && /location\.hash === '#upload'/.test(read('club/admin/photos.html')));
  const flags = read('js/admin-flags.js');
  check('no dues bar on the home (the banner has the numbers)', /dues-ticker/.test(flags) && /isDashboard/.test(flags));
}

console.log('W2 · the gate unlock for every board member (offline)');
if (bh) {
  const panel = { status: 'active', panel_host: '10.0.0.5', bridge_last_seen_at: new Date().toISOString() };
  const g = bh.gateCard(FEATURES, panel, caller('treasurer'));
  check('the Treasurer gets the unlock too, not only the President', g.show === true && g.online === true, short(g));
  check('no unlock when the club has keyfobs off', bh.gateCard({ ...FEATURES, keyfobs: false }, panel, caller('president')).show === false);
  check('no unlock without remote unlock set up', bh.gateCard({ ...FEATURES, gate: false }, panel, caller('president')).show === false && bh.gateCard(FEATURES, { ...panel, panel_host: null }, caller('president')).show === false);
  const old = bh.gateCard(FEATURES, { ...panel, bridge_last_seen_at: new Date(Date.now() - 3600e3).toISOString() }, caller('grounds'));
  check('bridge not answering: shown as offline, no button', old.show === true && old.online === false, short(old));
}
{
  const ga = read('supabase/functions/gate_admin/index.ts');
  const act = ga.slice(ga.indexOf("action === 'board_unlock'"), ga.indexOf("action === 'test_unlock'"));
  check('gate_admin board_unlock: any active board member', ga.includes("action === 'board_unlock'") && /gate_attendant/.test(act) && !/requireOwner/.test(act));
  check('it never queues an unlock while the bridge is off', /bridgeOnline\(/.test(act) && act.indexOf('bridgeOnline(') < act.indexOf(".insert("));
  check('it needs keyfobs and remote unlock on', /features\.keyfobs/.test(act) && /features\.gate/.test(act));
  check('each unlock records who opened the gate', /admin_user_id:/.test(act) && /actor_kind: 'admin'/.test(act));
  const mig = (await import('node:fs')).readdirSync(new URL('supabase/migrations/', root)).filter(f => /gate_unlock_by/.test(f));
  check('a migration adds who opened it', mig.length === 1 && /admin_user_id/.test(read('supabase/migrations/' + mig[0])) && /'admin'/.test(read('supabase/migrations/' + mig[0])), short(mig));
  const page = read('club/admin/index.html');
  check('the home\'s button uses board_unlock', /action: 'board_unlock'/.test(page) && !/test_unlock/.test(page));
}

console.log('W3 · the bottom bar on every board page (offline)');
{
  const vm = await import('node:vm');
  const src = read('js/admin-subtabs.js');
  // Run the nav script with a bare page around it, as if on the dashboard.
  const sandbox = { window: {}, document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], head: { appendChild() {} }, createElement: () => ({ style: {} }), addEventListener() {}, readyState: 'complete', body: { classList: { add() {}, remove() {}, toggle() {} }, insertAdjacentHTML() {} } }, localStorage: { getItem: () => null, setItem() {} }, location: { pathname: '/club/admin/', hash: '' }, console };
  sandbox.window = Object.assign(sandbox, { matchMedia: () => ({ matches: false, addEventListener() {} }) });
  let nav = null;
  try { vm.runInNewContext(src, sandbox); nav = sandbox.AdminNav; } catch (e) { check('the nav script runs', false, e.message); }
  check('AdminNav works out the sections each person can use', !!(nav && nav.sectionsFor && nav.render));
  if (nav && nav.sectionsFor) {
    const user = n => ({ role_template: POS[n].full ? 'owner' : 'custom', scopes: POS[n].scopes });
    const F = { gate: true, keyfobs: true, parties: true, programs: false, volunteer: false, lifeguard_scheduling: false };
    const keysOf = n => nav.sectionsFor(user(n), F).map(x => x.key);
    check('President: every section', ['members', 'money', 'calendar', 'content', 'insights', 'settings'].every(k => keysOf('president').includes(k)), short(keysOf('president')));
    check('Treasurer: Members and Money, no Calendar', keysOf('treasurer').includes('members') && keysOf('treasurer').includes('money') && !keysOf('treasurer').includes('calendar'), short(keysOf('treasurer')));
    const fac = nav.sectionsFor(user('facilities'), F);
    // Keyfobs moved under Members (PLAN.md X1): their Members tab opens it.
    check('Facilities Director: Members opens Keyfobs (it used to be hidden)', fac.some(x => x.key === 'members' && /keyfobs\.html/.test(x.href)) && !fac.some(x => x.key === 'money'), short(fac));
    check('Events & Rentals: Calendar opens Parties when Events is ticked off', nav.sectionsFor({ role_template: 'custom', scopes: ['parties'] }, F).some(x => x.key === 'calendar' && /parties\.html/.test(x.href)));
    const bar = nav.barFor(user('president'), F);
    check('the bar: Home, three sections, More', bar.length === 5 && bar[0].key === 'home' && bar[4].key === 'more', short(bar.map(b => b.key)));
    check('the bar for Grounds (no screens): Home, Content, Settings, More', JSON.stringify(nav.barFor(user('grounds'), F).map(b => b.key)) === JSON.stringify(['home', 'content', 'settings', 'more']), short(nav.barFor(user('grounds'), F).map(b => b.key)));
  }
  check('phones only, fixed to the bottom; the top tabs stay on computers', /@media \(max-width: 767px\)/.test(src) && /\.btabs \{[^}]*position: fixed[^}]*bottom: 0/.test(src) && /nav\.tabs \{ display: none/.test(src));
  check('More has the rest, help, member view and sign out', /Help and guides/.test(src) && /Member view/.test(src) && /Sign out/.test(src));
  check('the bar shows the waiting numbers', /poolside:badges/.test(src) && /poolside:badges/.test(read('js/admin-flags.js')));
  check('the "?" button steps aside for the bar on phones', /has-btabs #poolside-help-fab/.test(src));
  const flags = read('js/admin-flags.js');
  check('every page draws it once it knows who is signed in', /AdminNav\.render\(/.test(flags) && /poolside_tenant_features/.test(flags));
  const fs = await import('node:fs');
  const pages = fs.readdirSync(new URL('club/admin/', root)).filter(f => f.endsWith('.html'));
  const missing = pages.filter(f => /<nav class="tabs">/.test(read('club/admin/' + f)) && !/\/js\/admin-subtabs\.js/.test(read('club/admin/' + f)));
  check('every page with the board tabs loads the bar', missing.length === 0, short(missing));
}

if (LIVE) {
  console.log('\nLive (Bishop, temporary board logins)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-w/1.0' },
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
  const admTok = id => jwt({ sub: id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const keys = h => (h?.home?.stats ?? []).map(s => s.key);
  try {
    const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
    const own = await fn('admin_tasks', { action: 'home' }, admTok(owner.id));
    check('W1: the President\'s home in one call', own.ok && same(keys(own), ['paid', 'collected', 'on_plan']) && Array.isArray(own.tasks) && own.home.quick.length === 4, short(own.error || keys(own)));
    const ls = await fn('admin_tasks', { action: 'list' }, admTok(owner.id));
    check('W1: the plain task list (tab numbers on every page) still works', ls.ok && Array.isArray(ls.tasks) && !ls.home && Array.isArray(ls.my_positions), short(ls.error));
    check('W1: today, the week and the season come with it', own.ok && own.home.season >= 2026 && Array.isArray(own.home.events) && /^\d{4}-\d{2}-\d{2}$/.test(own.home.today), short({ season: own.home?.season, today: own.home?.today }));
    if (own.ok && own.home.gate.show) check('W1: the gate shows as offline while the bridge is off', own.home.gate.online === false, short(own.home.gate));
    const id = await makeTempAdmin(sql, club.id, 'Home Treasurer', POS.treasurer.scopes);
    const t1 = await fn('admin_tasks', { action: 'home' }, admTok(id));
    check('W1: a Treasurer gets the money numbers', t1.ok && same(keys(t1), ['collected', 'owed', 'on_plan']) && t1.home.signup_link === true, short(t1.error || keys(t1)));
    // The President changes the ticks: the same person's next visit follows.
    await sql(`update admin_users set scopes = array['check_in','shifts','keyfobs']::text[] where id = '${id}'`);
    const t2 = await fn('admin_tasks', { action: 'home' }, admTok(id));
    // W2: with the bridge off, a board member's tap is refused, and nothing
    // waits in the queue to open the gate when the bridge comes back.
    const un = await fn('gate_admin', { action: 'board_unlock' }, admTok(id));
    const [{ queued }] = await sql(`select count(*)::int as queued from gate_unlocks where admin_user_id = '${id}'`);
    check('W2: bridge off: the tap is refused and nothing is queued', un.ok === false && /offline/i.test(un.error || '') && queued === 0, short({ un, queued }));
    const me = await fn('tenant_admin_auth', { action: 'me' }, admTok(owner.id));
    check('W1: the dues bar numbers still come with sign-in', me.ok && me.usage?.dues && me.usage.dues.season >= 2026 && typeof me.usage.dues.paid === 'number', short(me.usage?.dues));
    check('W1: change the ticks, and the next visit shows the new ones', t2.ok && same(keys(t2), ['checkins', 'fobs_to_make', 'fobs_in_use']) && t2.home.signup_link === false, short(t2.error || keys(t2)));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    await purgeTempAdmins(sql, club.id);
    const [{ left }] = await sql(`select count(*)::int as left from admin_users where tenant_id = '${club.id}' and username like 'simtest-%'`);
    check('cleanup: the temporary board logins are gone', left === 0, String(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

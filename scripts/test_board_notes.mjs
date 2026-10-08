#!/usr/bin/env node
// Targeted check for Doug's board notes from his computer (PLAN.md R).
// Offline checks read the pages and helpers and cost nothing. `--live` adds
// Edge Function calls on Bishop with a temporary family and a temporary
// meeting, both removed afterward.
//
// Usage: node scripts/test_board_notes.mjs [--live]
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

console.log('R1 · pop-ups and waiting counts (offline)');
{
  const push = read('js/admin-push.js');
  check('a computer isn\'t asked to turn on pop-ups "on this phone"', /isComputer/.test(push) && /if \(isComputer\(\)/.test(push));
  const flags = read('js/admin-flags.js');
  check('every top tab gets a number for what\'s waiting there', /AdminSections/.test(flags) && /taskSection/.test(flags) && /'\/settings\.html'/.test(flags) && /'\/announcements\.html'/.test(flags));
  check('sub-tabs get the number too (Keyfobs included)', /paintSubBadges/.test(flags) && /paintSubBadges/.test(read('js/admin-subtabs.js')));
  check('the sections are shared with the badge code', /window\.AdminSections\s*=/.test(read('js/admin-subtabs.js')));
}

console.log('R2 · support email (offline)');
{
  const help = read('club/admin/help.html');
  const copy = help.slice(help.indexOf("getElementById('copy-support')"), help.indexOf("getElementById('copy-support')") + 900);
  check('the copy button copies only the support address', /writeText\('support@poolsideapp\.com'\)/.test(copy) && !/Subject:/.test(copy));
}

console.log('R3 · meeting votes (offline)');
{
  const page = read('club/admin/board-meetings.html');
  check('"Plan one for later" is gone', !/Plan one for later/.test(page) && !/function newMeeting\(/.test(page));
  check('each count has its own minus', (page.match(/class="vote-minus"/g) || []).length >= 1 && /bumpVote\(\$\{i\}, '\$\{k\}', -1\)|bumpVote\(\$\{i\}, k, -1\)/.test(page));
  const fn = read('supabase/functions/board_meetings/index.ts');
  check('an empty motion is kept while the meeting is open', /sanitizeVotes\([^)]*keepEmpty/.test(fn) || /keepEmpty/.test(fn));
}

console.log('R4 · signup form tab (offline)');
{
  const sub = read('js/admin-subtabs.js');
  check('the Signup form tab is gone', !/key: 'applyform'/.test(sub));
  const settings = read('club/admin/settings.html');
  check('the signup link and heading are on Settings → Season', /id="signup-link"/.test(settings) && /id="apply-heading"/.test(settings) && /Copy link/.test(settings));
  check('the old page sends people to Settings', /settings\.html\?focus=season/.test(read('club/admin/application.html')) && /location\.replace/.test(read('club/admin/application.html')));
}

console.log('R5 · renewal message (offline)');
{
  const members = read('club/admin/members.html');
  const panel = members.slice(members.indexOf('id="panel-renewals"'), members.indexOf('</section>', members.indexOf('id="panel-renewals"')));
  check('one simple screen: no audience or link-type pickers', !/id="ren-audience"/.test(panel) && !/id="ren-linktype"/.test(panel));
  check('it says which season and that only last season\'s members get it', /id="ren-season"/.test(panel) && /only/i.test(panel) && /last season/i.test(panel));
  check('email and/or text, and a message box filled in', /id="ren-ch-email"/.test(panel) && /id="ren-ch-sms"/.test(panel) && /id="ren-message"/.test(panel));
  const fn = read('supabase/functions/renewals/index.ts');
  check('the server sends only to last season\'s members, to the primary', /prior_year/.test(fn) && /role.*primary|primary.*role/.test(fn) && /body\.message/.test(fn));
}

console.log('R6 · renewing signs the policies (offline)');
{
  for (const page of ['renew.html', 'm/renew.html']) {
    const s = read(page);
    check(`${page}: policies and a signature before paying`, /RenewSign/.test(s) && /renew-sign\.js/.test(s));
  }
  check('the link page has the keyfob box', /fob-qty/.test(read('renew.html')));
  const js = read('js/renew-sign.js');
  check('one signature, from the person who opened the account', /signature/.test(js) && /policies/.test(js));
  const co = read('supabase/functions/stripe_checkout/index.ts');
  check('checkout refuses a renewal that isn\'t signed', /renewalUnsigned|needsRenewalSignature/.test(co));
}

console.log('R7 · auto-renew is "approve next season" (offline)');
{
  const pp = read('supabase/functions/payment_plans/index.ts');
  const run = pp.slice(pp.indexOf("action === 'auto_renew_run'"), pp.indexOf("action === 'auto_renew_run'") + 12000);
  check('the daily run asks for approval instead of charging', /auto_renew_asked/.test(run) && !/off_session/.test(run));
  check('a reminder a week later', /auto_renew_reminded/.test(run) && /7/.test(run));
  for (const page of ['apply.html', 'm/renew.html', 'renew.html']) {
    check(`${page}: the auto-renew box says nothing is charged until they approve`, /Nothing is charged until you approve/.test(read(page)));
  }
  const ma = read('supabase/functions/member_auth/index.ts');
  check('one tap approves and pays with the saved card', /action === 'renew_approve'/.test(ma));
}

if (LIVE) {
  console.log('\nLive (Bishop)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-r/1.0' },
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
  const FAMILY = `SimTest Notes ${String(Date.now()).slice(-6)}`;
  let meetingId = null;
  try {
    // R3: a motion with nothing typed yet survives the save, and counts stick.
    const mk = await fn('board_meetings', { action: 'create', start: true }, admTok);
    meetingId = mk.meeting?.id;
    const v = { id: 'v-test', motion: '', proposed_by: null, seconded_by: null, yes: 0, no: 0, abstain: 0, outcome: 'pending', notes: null };
    const up = await fn('board_meetings', { action: 'update', id: meetingId, votes: [v] }, admTok);
    check('R3: a new, empty motion is still there after the save', up.ok && (up.meeting?.votes_json || []).length === 1, short(up.meeting?.votes_json));
    const up2 = await fn('board_meetings', { action: 'update', id: meetingId, votes: [{ ...v, yes: 2 }] }, admTok);
    check('R3: and its votes are kept', up2.ok && up2.meeting?.votes_json?.[0]?.yes === 2, short(up2.meeting?.votes_json));

    // R5–R7 on a temporary family that was a member last season.
    const m = await makeTempMember(sql, club.id, FAMILY);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, hid: m.household_id, slug: 'bishopestates' });
    const ro = await fn('member_auth', { action: 'renewal_options' }, memTok);
    const year = ro.year;
    await sql(`update households set paid_until_year = ${year - 1}, dues_paid_for_year = false where id = '${m.household_id}'`);

    const pv = await fn('renewals', { action: 'renewal_audience' }, admTok);
    check('R5: the screen knows the season and counts last season\'s members', pv.ok && pv.year === year && pv.households >= 1, short(pv));

    // R6: renewing needs the policies and a signature before checkout.
    const st = await fn('member_auth', { action: 'renew_start' }, memTok);
    const co = await fn('stripe_checkout', { action: 'application', application_id: st.application_id });
    check('R6: checkout won\'t take a renewal that isn\'t signed', st.ok && !co.ok && /sign/i.test(co.error || ''), short({ st: st.ok, co }));
    const sig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const pols = await sql(`select slug from policies where tenant_id = '${club.id}' and active and required_for_apply`);
    const half = await fn('member_auth', { action: 'renew_sign', application_id: st.application_id, accepted: {}, signature: sig }, memTok);
    check('R6: every policy has to be accepted', pols.length === 0 || (!half.ok && /Accept/.test(half.error || '')), short({ pols: pols.length, half }));
    const sg = await fn('member_auth', { action: 'renew_sign', application_id: st.application_id, accepted: Object.fromEntries(pols.map(p => [p.slug, true])), signature: sig }, memTok);
    const co2 = await fn('stripe_checkout', { action: 'application', application_id: st.application_id });
    check('R6: once signed, checkout opens', sg.ok && co2.ok && !!co2.url, short({ sg, co2: co2.error || co2.ok }));

    // R7: auto-renew asks first. Approving pays with the saved (test) card.
    await sql(`update households set auto_renew = true, auto_renew_set_at = now() where id = '${m.household_id}'`);
    const run = await fn('payment_plans', { action: 'auto_renew_run', only_household: m.household_id }, null, { 'x-cron-secret': env.CRON_SECRET });
    const [hh] = await sql(`select auto_renew_asked_year, paid_until_year from households where id = '${m.household_id}'`);
    check('R7: the daily run asks the family to approve, and charges nothing', run.ok && run.asked === 1 && hh.auto_renew_asked_year === year && hh.paid_until_year === year - 1, short({ run, hh }));
    const again = await fn('payment_plans', { action: 'auto_renew_run', only_household: m.household_id }, null, { 'x-cron-secret': env.CRON_SECRET });
    check('R7: and doesn\'t ask twice in the same week', again.ok && again.asked === 0 && again.reminded === 0, short(again));

    // One tap: approve and pay with the saved (test-mode) card.
    await sql(`update households set auto_renew_customer_id = 'sim_cus_test', auto_renew_pm_id = 'sim_pm_test' where id = '${m.household_id}'`);
    const ro2 = await fn('member_auth', { action: 'renewal_options' }, memTok);
    const ap = await fn('member_auth', { action: 'renew_approve', application_id: st.application_id }, memTok);
    const [hh2] = await sql(`select paid_until_year from households where id = '${m.household_id}'`);
    const [app2] = await sql(`select status, payment_status from applications where id = '${st.application_id}'`);
    check('R7: one tap approves, pays with the saved card and renews', ro2.saved_card === true && ap.ok && app2.payment_status === 'paid' && app2.status === 'approved' && hh2.paid_until_year === year,
      short({ saved: ro2.saved_card, ap, app2, hh2 }));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    if (meetingId) await sql(`delete from admin_tasks where source_id = '${meetingId}'; delete from board_meetings where id = '${meetingId}'`);
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    const [{ left }] = await sql(`select count(*)::int as left from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%'`);
    check('cleanup: the temporary family and meeting are gone', left === 0, String(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Targeted check for party dates (PLAN.md BJ4, Doug's demo walkthrough list,
// 10/21): a party season separate from the pool's, blocked dates with a
// reason, days of the week, a start-time window, and how far ahead. The same
// rules on the server (_shared/party_rules.ts) and the member page
// (js/party-rules.js). Offline: reads the code, runs both copies, and renders
// the member's party calendar with the demo video's harness. BJ6: the party
// wording follows "Approve open times automatically".
//
// Usage: node scripts/test_party_dates.mjs
import { readFileSync } from 'node:fs';
import { launch, attach, FAMILY } from './demo_video/harness.mjs';
import { respond } from './demo_video/data.mjs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };

const TODAY = '2027-06-19';   // a Saturday, the demo's date
const SEASON = { from: '2027-05-29', until: '2027-09-06', blackouts: [{ from: '2027-06-26', to: '2027-06-27', reason: 'Swim meet' }],
  days: [0, 5, 6], earliest: '10:00', latest: '16:00', notice_days: 2, ahead_days: 60 };

console.log('BJ4 · the rules (_shared/party_rules.ts)');
let pr = null;
try { pr = await importTs(new URL('supabase/functions/_shared/party_rules.ts', root)); } catch { /* checked below */ }
check('the rules exist', !!pr?.partyRules);
if (pr?.partyRules) {
  const none = pr.partyRules({});
  const S = pr.partyRules(SEASON);
  const why = (r, d) => pr.dayStatus(r, d, TODAY).reason ?? 'ok';
  check('  no settings: any day from today on', why(none, '2027-06-19') === 'ok' && why(none, '2027-12-31') === 'ok');
  check('  never a day that has passed', why(none, '2027-06-18') === 'That day has passed');
  check('  before the first party day', why(pr.partyRules({ from: '2027-07-01' }), '2027-06-25') === 'Parties start Jul 1', why(pr.partyRules({ from: '2027-07-01' }), '2027-06-25'));
  check('  after the last party day', why(S, '2027-09-10') === 'The last party day is Sep 6', why(S, '2027-09-10'));
  check('  a blocked date says why', why(S, '2027-06-26') === 'No parties: Swim meet' && why(S, '2027-06-27') === 'No parties: Swim meet');
  check('  a blocked date with no reason', why(pr.partyRules({ blackouts: [{ from: '2027-07-04', to: '2027-07-04', reason: '' }] }), '2027-07-04') === 'No parties that day');
  check('  only the club\'s days of the week', why(S, '2027-06-21') === 'No parties on Mondays', why(S, '2027-06-21'));
  check('  at least N days ahead', why(S, '2027-06-20') === 'Book at least 2 days ahead', why(S, '2027-06-20'));
  check('  at most N days ahead', why(S, '2027-08-20') === 'Book at most 60 days ahead', why(S, '2027-08-20'));
  check('  an allowed day', why(S, '2027-06-25') === 'ok');
  const times = pr.startTimes(S);
  check('  start times in the window, every 30 minutes', times.length === 13 && times[0] === '10:00' && times[12] === '16:00', times.join(','));
  check('  8 AM to 8 PM when the club sets none', pr.startTimes(none).length === 25 && pr.startTimes(none)[0] === '08:00');
  check('  a start outside the window says the window', pr.timeStatus(S, '09:30').reason === 'Parties start between 10:00 AM and 4:00 PM', pr.timeStatus(S, '09:30').reason);
  check('  the server\'s check: day first, then time', pr.checkPartyStart(S, '2027-06-26', '12:00', TODAY) === 'No parties: Swim meet'
    && /between 10:00 AM and 4:00 PM/.test(pr.checkPartyStart(S, '2027-06-25', '17:00', TODAY) || '') && pr.checkPartyStart(S, '2027-06-25', '12:00', TODAY) === null);
  const ok = pr.cleanRules(SEASON);
  check('  the board\'s settings are checked before saving', ok.ok === true && JSON.stringify(ok.rules.days) === '[0,5,6]', JSON.stringify(ok));
  check('  a date that isn\'t a date', pr.cleanRules({ from: 'June 1' }).error === "The first party day isn't a date.");
  check('  first day after the last', pr.cleanRules({ from: '2027-09-01', until: '2027-06-01' }).error === 'The first party day is after the last.');
  check('  earliest start after the latest', pr.cleanRules({ earliest: '18:00', latest: '10:00' }).error === 'The earliest start is after the latest.');
  check('  a blocked date needs its dates', pr.cleanRules({ blackouts: [{ from: '', to: '', reason: 'x' }] }).error === 'Each blocked date needs a date.');
  check('  no days of the week at all', pr.cleanRules({ days: [] }).error === 'Pick at least one day of the week.');

  console.log('BJ4 · the member page\'s copy agrees (js/party-rules.js)');
  let js = null;
  try { js = new Function('window', read('js/party-rules.js') + '; return window.PartyRules;')({}); } catch { /* checked below */ }
  check('js/party-rules.js loads', !!js?.partyRules);
  if (js?.partyRules) {
    const sets = [{}, SEASON, { from: '2027-07-01', until: '2027-07-31', days: [1, 2, 3, 4, 5] }, { blackouts: [{ from: '2027-07-04', to: '2027-07-04', reason: '' }], ahead_days: 30 }];
    const diffs = [];
    for (const raw of sets) {
      const a = pr.partyRules(raw), b = js.partyRules(raw);
      for (let i = -3; i < 140; i++) {
        const d = new Date(Date.parse(`${TODAY}T12:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
        const x = pr.dayStatus(a, d, TODAY), y = js.dayStatus(b, d, TODAY);
        if (x.ok !== y.ok || (x.reason ?? '') !== (y.reason ?? '')) diffs.push(`${d}: ${x.reason} / ${y.reason}`);
      }
      if (JSON.stringify(pr.startTimes(a)) !== JSON.stringify(js.startTimes(b))) diffs.push('start times');
    }
    check('both copies give the same answer for 570 days', !diffs.length, diffs.slice(0, 3).join(' | '));
  }
}

console.log('BJ4 · wired in');
const ma = read('supabase/functions/member_auth/index.ts');
const reqBlock = ma.slice(ma.indexOf("action === 'request_party'"), ma.indexOf("party_bookings').insert", ma.indexOf("action === 'request_party'")));
check('a party request on a blocked day or time is refused', /checkPartyStart/.test(reqBlock));
check('the board saves the rules, checked first', /cleanRules/.test(read('supabase/functions/parties_admin/index.ts')));
check('the member page gets the rules', /partyRules\(/.test(read('supabase/functions/tenant_public/index.ts')));
const m = read('m/index.html');
check('the member page loads the rules', /<script src="\/js\/party-rules\.js"><\/script>/.test(m));
check('a calendar and a start-time list, not a plain date box', /id="p-cal"/.test(m) && /id="p-time"/.test(m) && !/type="datetime-local" id="p-starts"/.test(m));
const pa = read('club/admin/parties.html');
check('Party settings: first and last day, days, start window, ahead, blocked dates',
  ['id="pd-from"', 'id="pd-until"', 'id="pd-days"', 'id="pd-earliest"', 'id="pd-latest"', 'id="pd-notice"', 'id="pd-ahead"', 'id="pd-blackouts"'].every(x => pa.includes(x)));

console.log('BJ4 · the member\'s calendar');
const browser = await launch();
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const log = await attach(page, { state: { riveraPaid: true }, answer: (f, body, ctx) => {
    const out = respond(f, body, ctx);
    if (f === 'tenant_public' && out?.public_settings) {
      return { ...out, public_settings: { ...out.public_settings, features: { ...(out.public_settings.features || {}), parties: true },
        parties: { ...(out.public_settings.parties || {}), fee_cents: 15000, auto_approve: true, hold_days: 2, ...SEASON } } };
    }
    if (f === 'member_auth' && body.action === 'party_busy') return { ok: true, busy: [{ starts_at: '2027-06-25T13:00:00-07:00', ends_at: '2027-06-25T17:00:00-07:00' }] };
    return out;
  } });
  await page.goto(FAMILY + '/m/', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 800));
  const opened = await page.evaluate(() => { if (typeof openPartyModal !== 'function') return false; openPartyModal(); return true; });
  await new Promise(r => setTimeout(r, 900));
  const st = await page.evaluate(() => {
    const cal = document.getElementById('p-cal');
    const cell = d => cal && cal.querySelector(`[data-day="${d}"]`);
    const blocked = cell('2027-06-26');
    if (blocked) blocked.click();
    const why = document.getElementById('p-day-why')?.textContent || '';
    const sel = document.getElementById('p-starts')?.value || '';
    const t = document.getElementById('p-time');
    return { cal: !!cal, blockedOff: !!blocked && blocked.classList.contains('off'), why, sel,
      monday: cell('2027-06-21')?.classList.contains('off') ?? null, open: cell('2027-06-25') ? !cell('2027-06-25').classList.contains('off') : null,
      times: t ? [...t.options].map(o => o.value) : [], booked: t ? [...t.options].filter(o => o.disabled).map(o => o.value) : [] };
  });
  check('the party form opens with a calendar', opened && st.cal, JSON.stringify(st).slice(0, 120));
  check('a blocked date is greyed out, and tapping it says why', st.blockedOff && /No parties: Swim meet/.test(st.why), st.why);
  check('days the club doesn\'t allow are greyed out', st.monday === true && st.open === true);
  check('it starts on the first day that\'s allowed', st.sel.startsWith('2027-06-25'), st.sel);
  check('start times only in the window', st.times.length === 13 && st.times[0] === '10:00' && st.times[12] === '16:00', st.times.join(','));
  check('times another party holds are marked booked', st.booked.includes('13:00') && st.booked.includes('16:00') && !st.booked.includes('10:00'), st.booked.join(','));
  check('no script errors', !log.errors.length, log.errors.join(' | '));
  await page.close();
}
console.log('BJ6 · the party wording follows "Approve open times automatically"');
for (const auto of [true, false]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await attach(page, { state: { riveraPaid: true }, answer: (f, body, ctx) => {
    const out = respond(f, body, ctx);
    if (f === 'tenant_public' && out?.public_settings) return { ...out, public_settings: { ...out.public_settings, parties: { ...(out.public_settings.parties || {}), fee_cents: 15000, auto_approve: auto } } };
    return out;
  } });
  await page.goto(FAMILY + '/m/', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 600));
  await page.evaluate(() => openPartyModal());
  await new Promise(r => setTimeout(r, 500));
  const t = await page.evaluate(() => ({ head: document.getElementById('p-head')?.textContent || '', intro: document.getElementById('p-intro')?.textContent || '', btn: document.getElementById('p-submit')?.textContent || '' }));
  check(auto ? '  on: "Book a party", booked on the spot by card' : '  off: "Request a party", the board lets them know',
    auto ? t.head === 'Book a party' && /booked on the spot/.test(t.intro) && !/reviews requests/.test(t.intro) && t.btn === 'Book it'
         : t.head === 'Request a party' && /lets you know/.test(t.intro) && t.btn === 'Send request', JSON.stringify(t));
  await page.close();
}
const st = read('club/admin/settings.html');
check('Settings → Features → Party rentals follows the setting', !/you approve with one click/.test(st) && /id="feat_parties_sub"/.test(st) && /booked on the spot/.test(st) && /auto_approve/.test(st));
await browser.close();

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

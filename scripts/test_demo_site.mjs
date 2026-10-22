#!/usr/bin/env node
// Targeted check for the demo club at demo.poolsideapp.com (PLAN.md BG9; Doug
// 10/20: "an entire example that people can have access to... it really does
// nothing... i dont want texts generated or sent nor emails"). Every board and
// member screen renders with the demo's own answers and no errors; nothing
// reaches Supabase; the built data is up to date; the demo only switches on
// for its own address. Offline (renders in Chrome, no calls).
//
// Usage: node scripts/test_demo_site.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { buildDemoData, buildPre } from './demo_video/build_demo_site.mjs';
import { siteRespond, WOULD } from './demo_video/site_data.mjs';
import { DEMO_NOW } from './demo_video/data.mjs';
import { launch, attach, FAMILY, BOARD } from './demo_video/harness.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BG9 · the demo club is built and wired');
check('demo/demo-data.js is up to date (run build_demo_site.mjs)', read('demo/demo-data.js') === await buildDemoData());
check('the demo page helper uses the same date as the data', read('demo/demo-ui.js').includes(`Date.parse('2027-06-19T10:40:00-07:00')`) && DEMO_NOW === Date.parse('2027-06-19T10:40:00-07:00'));
const sw = read('sw.js');
check('sw.js loads the demo only on demo.poolsideapp.com', /if \(self\.location\.hostname === 'demo\.poolsideapp\.com'\) importScripts\('\/demo\/demo-sw\.js'\)/.test(sw));
const dsw = read('demo/demo-sw.js');
check('every Supabase call is answered in the browser', /hostname\.endsWith\('\.supabase\.co'\)\) \{ event\.respondWith\(answer\(event\)\)/.test(dsw) && !/fetch\(event\.request\)\s*;?\s*\}\s*$/.test(dsw));
check('pages get the demo banner and notes first', /<script src="\/demo\/demo-ui\.js"><\/script>/.test(dsw) && /Demo club\. Maple Grove is made up/.test(read('demo/demo-ui.js')));
check('the start page opens only once the demo is running', /aria-disabled="true"/.test(read('demo/index.html')) && /navigator\.serviceWorker\.controller/.test(read('demo/index.html')));
const vj = JSON.parse(read('vercel.json'));
check('demo.poolsideapp.com/ opens the start page', vj.rewrites.some(r => r.source === '/' && r.destination === '/demo/index.html' && /demo/.test(JSON.stringify(r.has))));
for (const k of ['sms_blasts:approve', 'renewals:send_renewal_links', 'applications:approve', 'gate_admin:board_unlock', 'payment_plans:approve', 'member_auth:start']) {
  check(`  says what "${k}" would do`, /In a real club/.test(WOULD[k] || ''));
}

// Found building the demo: check-in and My shifts called PoolsideAuth
// without loading the file it lives in, and always said "Could not load".
{
  const web0 = new URL('./', root).pathname;
  const missing = [...readdirSync(web0 + 'club/admin').map(f => 'club/admin/' + f), ...readdirSync(web0 + 'm').map(f => 'm/' + f)]
    .filter(f => f.endsWith('.html')).filter(f => /PoolsideAuth|PoolsideFlags/.test(read(f)) && !/admin-flags\.js/.test(read(f)));
  check('every page that uses the sign-in helper loads it', !missing.length, missing.join(', '));
}

console.log('BG9 · every screen works with the demo\'s answers');
const pre = await buildPre();
const web = new URL('./', root).pathname;
const skip = new Set(['login.html', 'activate.html', 'applications.html', 'application.html', 'verify.html', 'change-password.html']);
const pages = [
  ...readdirSync(web + 'club/admin').filter(f => f.endsWith('.html') && !skip.has(f)).map(f => ['board', '/club/admin/' + f]),
  ...readdirSync(web + 'm').filter(f => f.endsWith('.html') && !skip.has(f)).map(f => ['family', '/m/' + f]),
  ['family', '/club/index.html'], ['family', '/apply.html'], ['family', '/governance.html'],
];
const b = await launch();
const problems = [];
for (const [side, path] of pages) {
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844 });
  const state = {};
  const log = await attach(p, { state, answer: (fn, body, ctx) => siteRespond(fn, body, { ...ctx, pre }) });
  try { await p.goto((side === 'board' ? BOARD : FAMILY) + path, { waitUntil: 'networkidle0', timeout: 30000 }); } catch (e) { log.errors.push('load: ' + e.message); }
  await new Promise(r => setTimeout(r, 900));
  const shown = await p.evaluate(() => [...[...document.querySelectorAll('.err.show, [id$="-err"].show')].map(e => e.textContent.trim()).filter(Boolean),
    ...(/Could not load|Couldn.t load/.test(document.body.innerText) ? ['says it could not load'] : [])]).catch(() => []);
  const errs = [...new Set(log.errors)];
  if (errs.length || shown.length) problems.push(`${path}: ${[...errs, ...shown].join(' / ').slice(0, 200)}`);
  await p.close();
}
check(`${pages.length} screens open with no script errors or error boxes`, !problems.length, problems.join('\n      '));

// PLAN.md BJ7 (Doug's walkthrough list, items 24a and 26).
console.log('BJ7 · the demo shows card payments working; a connected gate ticks Keyfob / RFID gate');
check('the demo\'s Stripe answer says Poolside\'s card setup is done', siteRespond('stripe_connect', { action: 'status' }, { side: 'board', state: {}, pre })?.stripe_configured === true);
{
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844 });
  await attach(p, { state: {}, answer: (fn, body, ctx) => siteRespond(fn, body, { ...ctx, pre }) });
  await p.goto(BOARD + '/club/admin/payments.html', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 900));
  const stripe = await p.evaluate(() => document.getElementById('stripe-status')?.textContent || '');
  check('  Money → Payments says Stripe is ready, not "aren\'t available yet"', /Stripe ready/.test(stripe) && !/available yet/.test(stripe), stripe.slice(0, 100));
  await p.goto(BOARD + '/club/admin/settings.html', { waitUntil: 'networkidle0', timeout: 30000 });
  await new Promise(r => setTimeout(r, 1200));
  const fob = await p.evaluate(() => { const el = document.querySelector('#access-methods input[data-method="keyfob"]'); return el ? { checked: el.checked, disabled: el.disabled, text: el.closest('label').textContent } : null; });
  check('  the demo\'s connected gate shows Keyfob / RFID gate ticked, and why', fob?.checked === true && fob?.disabled === true && /connected/i.test(fob?.text || ''), JSON.stringify(fob));
  await p.close();
}
const st = readFileSync(new URL('club/admin/settings.html', root), 'utf8');
check('a connected gate keeps Keyfob / RFID gate on in any club (it can\'t be unticked while it\'s connected)', /GATE_CONNECTED/.test(st) && /paintAccessMethods\(LAST_SETTINGS/.test(st));

// PLAN.md BJ8 (Doug's walkthrough list, items 28 and 29: "All of 29").
console.log('BJ8 · the demo remembers what you do, until Start over');
const swSrc = read('demo/demo-sw.js'), uiSrc = read('demo/demo-ui.js');
check('the worker saves the demo\'s state in this browser and reads it back', /caches\.open\('demo-state'\)/.test(swSrc) && /__set/.test(swSrc) && /saveState\(/.test(swSrc));
check('Start over clears it (the page waits for that before starting again)', /caches\.delete\('demo-state'\)/.test(uiSrc) && /caches\.delete\('demo-state'\)/.test(swSrc));
{
  const S = {};
  const R = (fn, body, side = 'family', now) => siteRespond(fn, body, { side, state: S, pre, now });
  // A party, booked and paid by card.
  const bk = R('member_auth', { action: 'request_party', title: 'Pool party', starts_at: '2027-06-26T21:00:00.000Z', policies_accepted: true });
  check('a party request is kept, approved on the spot', bk?.ok && bk?.approved && bk?.party?.id && bk?.fee_cents === 15000, JSON.stringify(bk).slice(0, 120));
  const mine = R('member_auth', { action: 'list_my_parties' });
  check('  in Your party requests', (mine?.parties || []).some(x => x.id === bk.party?.id));
  const card = R('stripe_checkout', { action: 'party_booking', party_id: bk.party?.id });
  check('  paying by card books it', card?.ok && /^\//.test(card?.url || '') && R('member_auth', { action: 'list_my_parties' }).parties?.find(x => x.id === bk.party?.id)?.payment_status === 'paid');
  check('  on the board\'s Parties list, paid', (R('parties_admin', { action: 'list', status: 'all' }, 'board')?.bookings || []).some(x => x.id === bk.party?.id && x.payment_status === 'paid'));
  const ev = R('tenant_public', { slug: 'demo' })?.events || [];
  check('  on the club calendar as a private event, with the paid parties already there', ev.some(e => e.kind === 'party' && e.title === 'Private event' && String(e.starts_at).startsWith('2027-06-26'))
    && ev.filter(e => e.kind === 'party' && String(e.starts_at).slice(0, 10) === '2027-06-19').length >= 1, JSON.stringify(ev.filter(e => e.kind === 'party')).slice(0, 160));
  check('  its time shows as taken that day', (R('member_auth', { action: 'party_busy', date: '2027-06-26' })?.busy || []).length === 1);
  const doors = R('unlock_gate', { action: 'check' })?.doors || [];
  check('the host family\'s app has the Snack Shack on party day (the Riveras, today)', doors.some(d => d.key === 'snack'), JSON.stringify(doors));
  // A party paid by Venmo, confirmed by the board.
  const v = R('member_auth', { action: 'request_party', title: 'Venmo party', starts_at: '2027-07-03T19:00:00.000Z', policies_accepted: true });
  R('member_auth', { action: 'claim_party_paid', id: v.party?.id });
  check('a Venmo the family says they sent waits in Venmo to check', (R('payments_admin', { action: 'venmo_waiting' }, 'board')?.items || []).some(i => i.id === v.party?.id));
  R('parties_admin', { action: 'verify_payment', id: v.party?.id, method: 'venmo' }, 'board');
  check('  confirmed: paid, and off the list', !(R('payments_admin', { action: 'venmo_waiting' }, 'board')?.items || []).some(i => i.id === v.party?.id)
    && R('member_auth', { action: 'list_my_parties' }).parties?.find(x => x.id === v.party?.id)?.payment_status === 'paid');
  // Sponsors.
  R('tenant_settings', { action: 'save', value: { sponsors_config: { popup_enabled: true, popup_frequency: 'every_load' } } }, 'board');
  const pub = R('tenant_public', { slug: 'demo' });
  check('turning on the sponsor pop-up reaches the member app, with a sponsor', pub?.public_settings?.sponsors_config?.popup_enabled === true && (pub?.sponsors || []).length > 0);
  check('  and Settings still says it\'s on', R('tenant_settings', { action: 'get' }, 'board')?.settings?.sponsors_config?.popup_enabled === true);
  // Board minutes: start, who's here, close, submit; the others approve; posted.
  const list0 = R('board_meetings', { action: 'list' }, 'board');
  check('Board minutes: the list is in the real shape (no red error)', list0?.ok && (list0.meetings || []).every(m => Array.isArray(m.attendees_json) && Array.isArray(m.votes_json) && Array.isArray(m.follow_ups_json)));
  const admins = R('board_meetings', { action: 'list_active_admins' }, 'board')?.admins || [];
  check('  who\'s here: the three board members', admins.length === 3);
  const c = R('board_meetings', { action: 'create', start: true }, 'board');
  check('  Start a meeting starts one', c?.meeting?.status === 'in_progress' && c?.meeting?.can_edit === true, JSON.stringify(c).slice(0, 100));
  const id = c?.meeting?.id;
  R('board_meetings', { action: 'update', id, notes_md: 'Shade sails go up July 6.', attendees: admins.map(a => ({ admin_user_id: a.id, name: a.name, source: 'admin' })),
    votes: [{ motion: 'Buy shade sails', outcome: 'passed' }], follow_ups: [{ description: 'Order the sails' }] }, 'board');
  const f = R('board_meetings', { action: 'finalize', id }, 'board');
  check('  Close meeting: minutes not approved yet, Submit for approval', f?.meeting?.minutes_status === 'draft' && f?.meeting?.approval?.can_submit === true);
  const t0 = Date.parse('2027-06-19T18:00:00Z');
  const sub = R('board_meetings', { action: 'submit_minutes', id }, 'board', t0);
  check('  submitted: 1 of 3 approved (Sam, by submitting)', sub?.meeting?.minutes_status === 'submitted' && sub?.meeting?.approval?.approved === 1 && sub?.meeting?.approval?.total === 3, JSON.stringify(sub?.meeting?.approval));
  const later = R('board_meetings', { action: 'get', id }, 'board', t0 + 15000);
  check('  a few seconds later the others have approved: approved', later?.meeting?.minutes_status === 'approved', later?.meeting?.minutes_status);
  const gov = R('board_meetings', { action: 'governance' }, 'family', t0 + 16000);
  check("  and they're on the members' Bylaws & board minutes page", (gov?.meetings || []).some(m => m.id === id && /Shade sails/.test(m.notes_md)));
  check('  the bylaws show there too', !!gov?.bylaws?.current);
}
{
  // The same, on the screens: one state across the pages, as the worker keeps it.
  const S = {};
  const page = async (side, path) => {
    const p = await b.newPage();
    await p.setViewport({ width: 390, height: 844 });
    p.on('dialog', d => d.accept());
    const log = await attach(p, { state: S, answer: (fn, body, ctx) => siteRespond(fn, body, { ...ctx, state: S, pre }) });
    await p.goto((side === 'board' ? BOARD : FAMILY) + path, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 900));
    return { p, log };
  };
  let { p } = await page('board', '/club/admin/board-meetings.html');
  const oops = await p.evaluate(() => (document.body.innerText.match(/[^\n]*(Cannot read properties|is not a function|is not iterable)[^\n]*/) || [''])[0]);
  check('Board minutes on screen: opens with no error (the bylaws box, the list, the next meeting)', !oops, oops);
  const byl = await p.evaluate(() => document.getElementById('bylaws-card')?.textContent.replace(/\s+/g, ' ').trim() || '');
  check('  the bylaws box shows the bylaws', /bylaws/i.test(byl) && /posted/.test(byl), byl.slice(0, 120));
  const start = await p.evaluate(async () => {
    const btn = [...document.querySelectorAll('button')].find(x => /Start a meeting/.test(x.textContent));
    if (!btn) return 'no button';
    btn.click(); await new Promise(r => setTimeout(r, 1500));
    return { open: document.getElementById('scrim')?.classList.contains('open'), banner: document.getElementById('state-text')?.textContent || '',
      admins: document.querySelectorAll('#attend-host input[type=checkbox], [data-admin]').length, err: document.querySelector('.err.show')?.textContent || '' };
  });
  check('Board minutes on screen: ▶ Start a meeting opens a running meeting with the board to tick', start?.open && /in progress/i.test(start?.banner || '') && !start?.err, JSON.stringify(start));
  await p.close();
  // Minutes the others approved show on the members' page.
  {
    const R = (fn, body, side, now) => siteRespond(fn, body, { side, state: S, pre, now });
    const ppl = R('board_meetings', { action: 'list_active_admins' }, 'board').admins;
    const m = R('board_meetings', { action: 'create', start: true }, 'board').meeting;
    R('board_meetings', { action: 'update', id: m.id, notes_md: 'Lifeguard schedule set for July.', attendees: ppl.map(x => ({ admin_user_id: x.id, name: x.name, source: 'admin' })) }, 'board');
    R('board_meetings', { action: 'finalize', id: m.id }, 'board');
    R('board_meetings', { action: 'submit_minutes', id: m.id }, 'board', Date.now() - 10000);
  }
  ({ p } = await page('family', '/governance.html'));
  const gov = await p.evaluate(() => document.body.innerText);
  check("members' Bylaws & board minutes on screen: the approved minutes and the bylaws link", /Lifeguard schedule set for July/.test(gov) && /Read the bylaws/.test(gov) && !/Cannot read properties/.test(gov), gov.replace(/\s+/g, ' ').slice(0, 160));
  await p.close();
  ({ p } = await page('board', '/club/admin/payments.html'));
  const before = await p.evaluate(() => document.querySelectorAll('.venmo-row').length);
  await p.evaluate(async () => { document.querySelector('.venmo-row[data-i="0"]')?.click(); await new Promise(r => setTimeout(r, 200)); document.getElementById('venmo-confirm-btn')?.click(); });
  await new Promise(r => setTimeout(r, 1500));
  await p.reload({ waitUntil: 'networkidle0' }); await new Promise(r => setTimeout(r, 900));
  const after = await p.evaluate(() => document.querySelectorAll('.venmo-row').length);
  check('Venmo to check on screen: Confirm selected takes it off, and it stays off', before > 0 && after === before - 1, `${before} → ${after}`);
  await p.close();
  siteRespond('tenant_settings', { action: 'save', value: { sponsors_config: { popup_enabled: true, popup_frequency: 'every_load' } } }, { side: 'board', state: S, pre });
  ({ p } = await page('family', '/m/'));
  await new Promise(r => setTimeout(r, 2500));
  const home = await p.evaluate(() => ({ pop: !!document.getElementById('sponsor-popup'), snack: [...document.querySelectorAll('.gate-door-btn')].some(x => /Snack Shack/.test(x.textContent)) }));
  check('member app on screen: the sponsor pop-up shows once it\'s on', home.pop, JSON.stringify(home));
  check('member app on screen: the Snack Shack button on party day', home.snack, JSON.stringify(home));
  await p.close();
}
await b.close();

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

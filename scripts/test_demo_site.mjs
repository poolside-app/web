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
await b.close();

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

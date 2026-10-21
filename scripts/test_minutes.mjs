#!/usr/bin/env node
// Targeted check for the bylaws and board minutes (PLAN.md BJ, Doug's demo
// walkthrough list, 10/21). Offline: reads the code, and renders
// /governance.html in Chrome with the demo video's harness (no Supabase calls).
//
// BJ1: the bylaws, minutes and board names are for the club's members only.
//
// Usage: node scripts/test_minutes.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { launch, attach, FAMILY, BOARD, ALEX } from './demo_video/harness.mjs';
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

console.log('BJ1 · the server answers only a signed-in member or board member');
const fn = read('supabase/functions/board_meetings/index.ts');
check("no anonymous 'list_public' any more", !/action === 'list_public'/.test(fn));
check("a 'governance' action", /action === 'governance'/.test(fn));
let gov = null;
try { gov = await importTs(new URL('supabase/functions/_shared/governance.ts', root)); } catch (e) { /* checked below */ }
check('_shared/governance.ts says who may read', !!gov?.readerFromClaims);
if (gov?.readerFromClaims) {
  const r = gov.readerFromClaims;
  check('  a member of the club may', r({ kind: 'member', sub: 'm1', tid: 't1', hid: 'h1' })?.kind === 'member');
  check('  a board member may', r({ kind: 'tenant_admin', sub: 'a1', tid: 't1' })?.kind === 'board');
  check('  nobody signed in may not', r(null) === null && r({}) === null);
  check('  a sign-in without a club may not', r({ kind: 'member', sub: 'm1' }) === null);
  check('  a provider or other kind of sign-in may not', r({ kind: 'provider', sub: 'p1', tid: 't1' }) === null);
}
const govBlock = fn.slice(fn.indexOf("action === 'governance'"), fn.indexOf("action === 'governance'") + 2500);
check('it checks the member is active in that club before answering', /household_members/.test(govBlock) && /active/.test(govBlock));
check('it checks a board sign-in is a board member', /boardCaller/.test(govBlock));
check('without a sign-in it answers 401 and nothing else', /401/.test(govBlock));

console.log('BJ1 · the bylaws file is private');
const migs = readdirSync(new URL('supabase/migrations/', root)).filter(f => /club_docs|bylaws_private/.test(f)).map(f => read('supabase/migrations/' + f)).join('\n');
check('a private storage folder for club documents', /club-docs/.test(migs) && /public[^,\n]*false|false[^,\n]*public/i.test(migs));
check('club_documents keeps the private path', /storage_path/.test(migs));
let docs = null;
try { docs = await importTs(new URL('supabase/functions/_shared/club_docs.ts', root)); } catch { /* checked below */ }
check('_shared/club_docs.ts finds a public club-assets file to move', !!docs?.publicPathOf);
if (docs?.publicPathOf) {
  const base = 'https://x.supabase.co';
  check('  its path inside the folder', docs.publicPathOf(`${base}/storage/v1/object/public/club-assets/t1/123-bylaws.pdf`, base, 't1') === 't1/123-bylaws.pdf');
  check("  never another club's file", docs.publicPathOf(`${base}/storage/v1/object/public/club-assets/t2/x.pdf`, base, 't1') === null);
  check('  never a file elsewhere', docs.publicPathOf('https://evil.com/club-assets/t1/x.pdf', base, 't1') === null);
}
check('readers get links that expire (signed links)', /createSignedUrl/.test(read('supabase/functions/_shared/club_docs.ts')));
check('a new upload moves to the private folder when posted', /set_bylaws[\s\S]{0,2500}moveToPrivate/.test(fn));

console.log('BJ1 · where the link shows');
check('not on the public club page', !/governance\.html/.test(read('club/index.html')));
check('still in the member app', /governance\.html/.test(read('m/index.html')));
const login = read('m/login.html');
const safeSrc = login.match(/function safeNext\([\s\S]*?\n}/)?.[0];
check('member sign-in can send you back afterwards (?next=)', !!safeSrc && /safeNext\(/.test(login.replace(safeSrc, '')));
if (safeSrc) {
  const safeNext = new Function(`${safeSrc}; return safeNext;`)();
  check('  back to a page on this site', safeNext('/governance.html') === '/governance.html');
  check('  never to another site', [null, '', '//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', 'governance.html'].every(v => safeNext(v) === null));
}

console.log('BJ1 · the page, signed in and signed out');
const SAMPLE = { ok: true, meetings: [{ id: 'm1', title: 'May board meeting', meeting_date: '2027-05-27', notes_md: 'Opening day plan approved.', attendees_json: [{ name: 'Mei Chen' }], votes_json: [], follow_ups_json: [] }],
  bylaws: { current: { id: 'd1', url: 'https://example.com/signed/bylaws.pdf?token=x', file_name: 'Bylaws.pdf', uploaded_at: '2026-10-08T16:17:27Z' }, earlier: [] },
  board: [{ name: 'Mei Chen', titles: ['President'] }] };
const browser = await launch();
async function open(origin) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800 });
  const seen = [];
  page.on('request', r => {
    if (!r.url().includes('/functions/v1/board_meetings') || r.method() !== 'POST') return;
    let b = {}; try { b = JSON.parse(r.postData() || '{}'); } catch { /* none */ }
    seen.push({ action: b.action, auth: r.headers().authorization || '' });
  });
  const log = await attach(page, { answer: (f, body, ctx) => f === 'board_meetings' && body.action === 'governance' ? SAMPLE : respond(f, body, ctx) });
  await page.goto(origin + '/governance.html', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 700));
  return { page, seen, log, url: page.url(), text: await page.evaluate(() => document.body.innerText).catch(() => '') };
}
const member = await open(FAMILY);
check('a signed-in member goes straight in (no sign-in again)', !/login\.html/.test(member.url) && /Mei Chen/.test(member.text) && /May board meeting/.test(member.text), member.url);
check('  the page sends their sign-in with the call', member.seen.some(s => s.action === 'governance' && /^Bearer \S+/.test(s.auth)), JSON.stringify(member.seen));
check('  and shows the bylaws link', await member.page.$eval('a[href*="signed/bylaws.pdf"]', () => true).catch(() => false));
check('  no anonymous call', !member.seen.some(s => s.action === 'list_public'));
const board = await open(BOARD);
check('a signed-in board member goes straight in', !/login\.html/.test(board.url) && /May board meeting/.test(board.text), board.url);
const out = await open(ALEX);
check('signed out: off to sign in, then back here', /\/m\/login\.html\?next=%2Fgovernance\.html$/.test(out.url), out.url);
check('  without asking for the minutes first', !out.seen.length, JSON.stringify(out.seen));
{
  const page = await browser.newPage();
  await attach(page);
  await page.goto(FAMILY + '/m/login.html?next=%2Fgovernance.html', { waitUntil: 'networkidle0', timeout: 45000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  check('sign-in page with ?next=, already signed in: straight back to the minutes', /\/governance\.html$/.test(page.url()), page.url());
}
await browser.close();

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

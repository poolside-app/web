#!/usr/bin/env node
// Targeted check for the bylaws and board minutes (PLAN.md BJ, Doug's demo
// walkthrough list, 10/21). Offline: reads the code, and renders
// /governance.html in Chrome with the demo video's harness (no Supabase calls).
//
// BJ1: the bylaws, minutes and board names are for the club's members only.
// BJ2: minutes are for Members (the default) or Board only; no public option.
// BJ3: minutes are approved by the board members who attended before members see them.
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

console.log('BJ2 · Members or Board only');
const mig2 = readdirSync(new URL('supabase/migrations/', root)).filter(f => /minutes_members/.test(f)).map(f => read('supabase/migrations/' + f)).join('\n');
check("existing public minutes become Members", /update public\.board_meetings set visibility = 'members' where visibility = 'public'/.test(mig2));
check('the database allows only Members or Board only, Members by default',
  /check \(visibility in \('private', 'members'\)\)/.test(mig2) && /set default 'members'/.test(mig2));
check("the server accepts Members or Board only", /VALID_VIS = new Set\(\['private', 'members'\]\)/.test(fn));
check('a new meeting is Members', !/visibility: 'public'/.test(fn) && (fn.match(/visibility: 'members'/g) || []).length >= 2);
check("the members' page shows Members minutes", /\.eq\('(posted_json->>)?visibility', 'members'\)/.test(govBlock));
check("an old page still sending 'public' gets Members", /'public'[^\n]*'members'/.test(fn.slice(fn.indexOf('if (body.visibility !== undefined)'), fn.indexOf('if (body.visibility !== undefined)') + 400)));
const bm = read('club/admin/board-meetings.html');
check('the editor offers Members first, then Board only', bm.indexOf('id="vis-members"') > 0 && bm.indexOf('id="vis-members"') < bm.indexOf('id="vis-private"') && !/id="vis-public"/.test(bm));
check('Members is picked when a meeting has no choice yet', /vis-\$\{m\.visibility === 'private' \? 'private' : 'members'\}/.test(bm));
check('no "Everyone" and no "public page" on the Board minutes page', !/Everyone<\/div>|public page|public minutes|on the public/i.test(bm));
check('the help article says Members too', !/public minutes page|🌐 Everyone/.test(read('club/admin/help/articles/board-minutes.md')) && /Members/.test(read('club/admin/help/articles/board-minutes.md')));

console.log('BJ3 · the approval rules (_shared/minutes_approval.ts)');
let ap = null;
try { ap = await importTs(new URL('supabase/functions/_shared/minutes_approval.ts', root)); } catch { /* checked below */ }
check('the rules exist', !!ap?.approversFor);
if (ap?.approversFor) {
  const att = [{ admin_user_id: 'a1', name: 'Mei Chen' }, { admin_user_id: 'a2', name: 'Sam Brooks' }, { admin_user_id: null, name: 'A member' },
    { admin_user_id: 'a3', name: 'Left the board' }, { admin_user_id: 'a1', name: 'Mei Chen' }];
  const rows = ap.approversFor(att, new Set(['a1', 'a2']), 'a2');
  check('  approvers: board members who attended, once each', JSON.stringify(rows.map(r => r.admin_id)) === '["a1","a2"]', JSON.stringify(rows));
  check('  the person who submits counts as approving', rows.find(r => r.admin_id === 'a2')?.status === 'approved' && rows.find(r => r.admin_id === 'a1')?.status === 'pending');
  const pr = ap.progress(rows);
  check('  "1 of 2 approved, waiting on Mei Chen"', pr.approved === 1 && pr.total === 2 && JSON.stringify(pr.pending) === '["Mei Chen"]' && pr.done === false, JSON.stringify(pr));
  check('  done when everyone has approved', ap.progress([{ name: 'x', status: 'approved' }]).done === true && ap.progress([]).done === true);
  const day = n => new Date(Date.parse('2027-06-01T12:00:00Z') + n * 86400000).toISOString();
  check('  the President can approve for someone from day 7, not before', ap.mayApproveFor(true, day(0), new Date(day(7))) && !ap.mayApproveFor(true, day(0), new Date(day(6))));
  check('  only the President', !ap.mayApproveFor(false, day(0), new Date(day(9))));
  check('  reminders on days 3 and 6', [3, 6].every(n => ap.remindDay('2027-06-01', ap.addDays('2027-06-01', n)) === 'remind')
    && [1, 2, 4, 5].every(n => !ap.remindDay('2027-06-01', ap.addDays('2027-06-01', n))));
  check('  day 7 tells the President', ap.remindDay('2027-06-01', '2027-06-08') === 'president');
  check('  editing: an open meeting saves as you type', ap.editMode({ status: 'in_progress' }) === 'open');
  check('  a closed meeting\'s draft can be fixed', ap.editMode({ status: 'completed', minutes_status: 'draft' }) === 'draft');
  check('  waiting for approval: locked', ap.editMode({ status: 'completed', minutes_status: 'submitted' }) === 'locked');
  check('  approved: a change becomes an amendment', ap.editMode({ status: 'completed', minutes_status: 'approved' }) === 'amend');
  const snap = ap.snapshot({ id: 'm1', title: 'T', meeting_date: '2027-06-01', notes_md: 'n', attendees_json: [], votes_json: [], follow_ups_json: [], visibility: 'members', created_by: 'x', started_at: null, ended_at: null, location: null });
  check('  members see a copy taken at approval, without board-only fields', snap.notes_md === 'n' && snap.visibility === 'members' && !('created_by' in snap) && !('id' in snap));
}

console.log('BJ3 · the database and the server');
const mig3 = readdirSync(new URL('supabase/migrations/', root)).filter(f => /minutes_approval/.test(f)).map(f => read('supabase/migrations/' + f)).join('\n');
check('minutes_status: draft, submitted or approved', /minutes_status[\s\S]{0,120}check \(minutes_status in \('draft', 'submitted', 'approved'\)\)/.test(mig3));
check('one approval row per approver per round', /create table if not exists public\.board_minutes_approvals/.test(mig3) && /unique \(meeting_id, round, admin_id\)/.test(mig3));
check('meetings already closed keep their minutes (approved, with the copy members see)', /set minutes_status = 'approved'[\s\S]{0,400}posted_json/.test(mig3));
for (const a of ['submit_minutes', 'approve_minutes', 'approve_for', 'request_changes', 'edit_again']) check(`  action '${a}'`, new RegExp(`action === '${a}'`).test(fn));
check("each approver gets their own 'minutes.approve' to-do and pop-up", /kind: 'minutes\.approve'[\s\S]{0,300}assigned_admin_id/.test(fn) || /assigned_admin_id[\s\S]{0,300}kind: 'minutes\.approve'/.test(fn));
check('asking for changes needs a note', /request_changes[\s\S]{0,900}note/.test(fn) && /Say what to change/.test(fn));
check('members see the approved copy', /posted_json/.test(govBlock));
check('waiting for approval: edits refused', /editMode\(/.test(fn) && /'locked'/.test(fn));
check('approved minutes: a change starts an amendment', /'amend'[\s\S]{0,400}minutes_status: 'draft'/.test(fn));
check('the daily run reminds and tells the President', /remindMinutes/.test(read('supabase/functions/payment_plans/index.ts')));
const bm3 = read('club/admin/board-meetings.html');
check('the page: Submit for approval, Approve, Request changes, Approve for, Edit again',
  ['Submit for approval', '✓ Approve', 'Request changes', 'Approve for', 'Edit again'].every(t => bm3.includes(t)));
check('the list shows how many have approved', /of \$\{[^}]*\} approved/.test(bm3));
check('members see "Amended" on a changed approved meeting', /Amended/.test(read('governance.html')));

console.log('BJ3 · an attendee can approve minutes they can\'t edit');
const browser = await launch();
const SUBMITTED = { id: 'mtg1', title: 'June board meeting', meeting_date: '2027-06-24', status: 'completed', minutes_status: 'submitted', visibility: 'members',
  started_at: '2027-06-24T19:02:00-07:00', ended_at: '2027-06-24T20:15:00-07:00', notes_md: 'Shade sails go up July 6.', attendees_json: [{ admin_user_id: 'demo-board', name: 'Sam Brooks', source: 'admin' }, { admin_user_id: 'adm-chen', name: 'Mei Chen', source: 'admin' }],
  votes_json: [], follow_ups_json: [], note_taker: 'Mei Chen', can_edit: false, can_delete: false, created_by: 'adm-chen',
  approval: { round: 1, rows: [{ admin_id: 'adm-chen', name: 'Mei Chen', status: 'approved' }, { admin_id: 'demo-board', name: 'Sam Brooks', status: 'pending' }],
    approved: 1, total: 2, pending: ['Sam Brooks'], can_approve: true, can_approve_for: [], can_submit: false, can_edit_again: false } };
const calls3 = [];
{
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 800 });
  await attach(page, { answer: (f, body, ctx) => {
    if (f === 'board_meetings') {
      calls3.push(body.action);
      if (body.action === 'list') return { ok: true, meetings: [SUBMITTED] };
      if (body.action === 'get') return { ok: true, meeting: SUBMITTED };
      if (body.action === 'approve_minutes') return { ok: true, meeting: { ...SUBMITTED, minutes_status: 'approved', approval: { ...SUBMITTED.approval, approved: 2, pending: [], can_approve: false } } };
      if (body.action === 'list_active_admins') return { ok: true, admins: [] };
      if (body.action === 'next') return { ok: true, meeting: null, items: [] };
      if (body.action === 'bylaws') return { ok: true, current: null, earlier: [], can_change: false };
      if (body.action === 'agenda') return { ok: true, items: [] };
    }
    return respond(f, body, ctx);
  } });
  await page.goto(BOARD + '/club/admin/board-meetings.html#m=mtg1', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 1200));
  const st = await page.evaluate(() => {
    const host = document.getElementById('approval');
    const btn = host && [...host.querySelectorAll('button')].find(b => /Approve/.test(b.textContent) && !/for/.test(b.textContent));
    return { text: host ? host.innerText : '', has: !!btn, disabled: btn ? btn.disabled : null, notes: document.getElementById('m-notes')?.disabled };
  });
  check('it says "1 of 2 approved" and who\'s left', /1 of 2 approved/.test(st.text) && /Sam Brooks/.test(st.text), st.text.slice(0, 120));
  check('its Approve button works (not greyed out with the rest)', st.has && st.disabled === false, JSON.stringify(st));
  check('the minutes themselves stay read-only', st.notes === true);
  if (st.has) {
    await page.evaluate(() => [...document.querySelectorAll('#approval button')].find(b => /Approve/.test(b.textContent) && !/for/.test(b.textContent)).click());
    await new Promise(r => setTimeout(r, 800));
  }
  check('tapping it approves', calls3.includes('approve_minutes'), calls3.join(','));
  await page.close();
}

console.log('BJ1 · the page, signed in and signed out');
const SAMPLE = { ok: true, meetings: [{ id: 'm1', title: 'May board meeting', meeting_date: '2027-05-27', notes_md: 'Opening day plan approved.', attendees_json: [{ name: 'Mei Chen' }], votes_json: [], follow_ups_json: [] }],
  bylaws: { current: { id: 'd1', url: 'https://example.com/signed/bylaws.pdf?token=x', file_name: 'Bylaws.pdf', uploaded_at: '2026-10-08T16:17:27Z' }, earlier: [] },
  board: [{ name: 'Mei Chen', titles: ['President'] }] };
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

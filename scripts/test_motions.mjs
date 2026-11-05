#!/usr/bin/env node
// Targeted check for motions in a meeting (PLAN.md BU, Doug 11/4: "simply
// click new motion, you check the persons name who started the motion, then
// vote from there if needed… someone can second the motion as well"; "Do
// count plus all In favor"; "Needs a second to vote"). Offline: renders the
// meeting page in Chrome with a made-up meeting.
//
// Usage: node scripts/test_motions.mjs
import { launch, attach, BOARD } from './demo_video/harness.mjs';
import { respond } from './demo_video/data.mjs';

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 300);

const ADMINS = [
  { id: 'demo-board', name: 'Sam Brooks', board_title: 'President', role: 'president' },
  { id: 'adm-chen', name: 'Mei Chen', board_title: 'Secretary', role: 'secretary' },
  { id: 'adm-ruiz', name: 'Ana Ruiz', board_title: 'Treasurer', role: 'treasurer' },
];
let MEETING = {
  id: 'mtg1', title: 'November board meeting', meeting_date: '2027-06-24', status: 'in_progress', minutes_status: 'draft', visibility: 'members',
  started_at: '2027-06-24T19:02:00-07:00', notes_md: '', can_edit: true, can_delete: true, created_by: 'demo-board', note_taker: 'Sam Brooks',
  attendees_json: [
    { admin_user_id: 'demo-board', name: 'Sam Brooks', role: 'President', source: 'admin' },
    { admin_user_id: 'adm-chen', name: 'Mei Chen', role: 'Secretary', source: 'admin' },
    { source: 'manual', name: 'Lee Park', role: 'New board member' },
  ],
  // A motion written before BU, with typed names.
  votes_json: [{ id: 'v-old', motion: 'Approve the budget', proposed_by: 'Pat Old', seconded_by: null, yes: 0, no: 0, abstain: 0, outcome: 'pending', notes: null }],
  follow_ups_json: [],
};
const saves = [];
const answer = (f, body, ctx) => {
  if (f === 'board_meetings') {
    if (body.action === 'list') return { ok: true, meetings: [MEETING] };
    if (body.action === 'get') return { ok: true, meeting: MEETING };
    if (body.action === 'list_active_admins') return { ok: true, admins: ADMINS };
    if (body.action === 'update') {
      saves.push(body);
      MEETING = { ...MEETING, attendees_json: body.attendees, votes_json: body.votes, follow_ups_json: body.follow_ups };
      return { ok: true, meeting: MEETING };
    }
    if (body.action === 'next') return { ok: true, meeting: null, items: [] };
    if (body.action === 'bylaws') return { ok: true, current: null, earlier: [], can_change: false };
    if (body.action === 'agenda') return { ok: true, items: [] };
  }
  return respond(f, body, ctx);
};

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept('Jo Guest'));
  await attach(page, { answer });
  await page.goto(BOARD + '/club/admin/board-meetings.html#m=mtg1', { waitUntil: 'networkidle0', timeout: 45000 });
  await page.waitForSelector('#votes-host .vote-row', { timeout: 8000 }).catch(() => {});

  console.log('BU2 · as the meeting opens');
  {
    const open = await page.evaluate(() => {
      const r = document.querySelector('#votes-host .vote-row');
      const b = re => [...r.querySelectorAll('button')].find(x => re.test(x.textContent));
      return { yes: b(/Yes/)?.disabled, all: b(/All in favor/)?.disabled, passed: b(/Passed/)?.disabled, minus: r.querySelector('.vote-minus')?.disabled };
    });
    check('a motion with no second is greyed out when the meeting opens, too', open.yes === true && open.all === true && open.passed === true && open.minus === true, short(open));
  }

  // A new motion.
  await page.evaluate(() => addVote());
  const row = async i => page.evaluate(idx => {
    const r = document.querySelectorAll('#votes-host .vote-row')[idx];
    if (!r) return null;
    const names = sel => [...r.querySelectorAll(`${sel} button[data-who]`)].map(b => ({ name: b.dataset.who, on: b.classList.contains('on') }));
    const btn = re => [...r.querySelectorAll('button')].find(b => re.test(b.textContent));
    const dis = re => { const b = btn(re); return b ? b.disabled : null; };
    return {
      made: names('.made-by'), second: names('.second-by'),
      other: !!r.querySelector('.made-by button[data-other]'),
      needs: /Needs a second before the vote/.test(r.innerText),
      yes: dis(/Yes/), no: dis(/No\b/), abstain: dis(/Abstain/), all: dis(/All in favor/), allText: btn(/All in favor/)?.textContent.trim() || '',
      passed: dis(/Passed/), failed: dis(/Failed/), tabled: dis(/Tabled/),
      counts: [...r.querySelectorAll('.vote-btn .count')].map(c => c.textContent.trim()),
      outcome: r.className,
    };
  }, i);
  const tap = (i, sel, name) => page.evaluate((idx, s, n) => {
    const r = document.querySelectorAll('#votes-host .vote-row')[idx];
    r.querySelector(`${s} button[data-who="${n}"]`)?.click();
  }, i, sel, name);

  console.log('BU1 · Made by and Seconded by are names to tap');
  let r = await row(1);
  check('everyone marked present is a name to tap, plus "Other…"', r && r.made.map(x => x.name).join(',') === 'Sam Brooks,Mei Chen,Lee Park' && r.other, short(r));
  await tap(1, '.made-by', 'Mei Chen');
  r = await row(1);
  check('tapping a name makes them the one who made it', r.made.find(x => x.name === 'Mei Chen')?.on === true, short(r.made));
  check('…and they aren\'t offered as the second', !r.second.some(x => x.name === 'Mei Chen') && r.second.length === 2, short(r.second));

  console.log('BU2 · Needs a second to vote');
  check('before a second: "Needs a second before the vote."', r.needs, short(r));
  check('…Yes, No, Abstain, All in favor, Passed and Failed are greyed out', [r.yes, r.no, r.abstain, r.all, r.passed, r.failed].every(x => x === true), short(r));
  check('…Tabled still works', r.tabled === false, short(r));
  await tap(1, '.second-by', 'Lee Park');
  r = await row(1);
  check('after a second, the vote opens', !r.needs && [r.yes, r.no, r.abstain, r.all, r.passed, r.failed].every(x => x === false), short(r));

  console.log('BU3 · All in favor');
  check('"All in favor" shows how many are present', /All in favor \(3\)/.test(r.allText), r.allText);
  await page.evaluate(() => [...document.querySelectorAll('#votes-host .vote-row')[1].querySelectorAll('button')].find(b => /All in favor/.test(b.textContent))?.click());
  r = await row(1);
  check('…sets Yes to 3, No and Abstain to 0, and Passed', r.counts.join(',') === '3,0,0' && /passed/.test(r.outcome), short(r));
  await page.evaluate(() => document.querySelectorAll('#votes-host .vote-row')[1].querySelector('.vote-minus')?.click());
  r = await row(1);
  check('− still takes one back (a guest who didn\'t vote)', r.counts[0] === '2', short(r.counts));

  console.log('BU1 · tap again, Other…, and new people');
  await tap(1, '.second-by', 'Lee Park');
  r = await row(1);
  check('tapping the second again takes it back, and the vote greys out', !r.second.some(x => x.on) && r.needs && r.yes === true, short(r));
  await page.evaluate(() => document.querySelectorAll('#votes-host .vote-row')[1].querySelector('.second-by button[data-other]')?.click());
  r = await row(1);
  check('"Other…" takes a typed name', r.second.find(x => x.name === 'Jo Guest')?.on === true && !r.needs, short(r.second));
  await page.evaluate(() => { const box = [...document.querySelectorAll('#attendance-host input[type="checkbox"]')].find(b => b.dataset.adminId === 'adm-ruiz'); box.click(); });
  r = await row(1);
  check('marking someone present adds them to the names', r.made.some(x => x.name === 'Ana Ruiz'), short(r.made));
  const old = await row(0);
  check('a motion written before keeps its typed name, picked', old.made.find(x => x.name === 'Pat Old')?.on === true, short(old.made));

  console.log('BU · it saves the names');
  await new Promise(res => setTimeout(res, 2200));
  const last = saves[saves.length - 1];
  const v = last?.votes?.[1];
  check('the motion is saved with who made it and who seconded', v?.proposed_by === 'Mei Chen' && v?.seconded_by === 'Jo Guest', short(v));
  check('no page errors', !errors.length, errors.join(' | '));
} finally { await browser.close(); }

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Targeted check for meeting agendas built from one-liners (PLAN.md L).
// Offline checks cost nothing. The live part runs against Bishop with
// temporary board logins and meetings it removes afterward.
//
// Usage: node scripts/test_agenda.mjs [--offline]   (ONLY=L1,L2 limits the live part)
import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const exists = rel => existsSync(new URL(rel, root));
const between = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, to ? src.indexOf(to, i + from.length) : undefined); };
const OFFLINE = process.argv.includes('--offline');
const ONLY = (process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
const live = step => !OFFLINE && (!ONLY.length || ONLY.includes(step));

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const short = o => String(JSON.stringify(o)).slice(0, 260);
const env = Object.fromEntries(read('.env.local')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-agenda/1.0' },
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
async function fn(name, action, token, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// ── L1: one-liners for the next meeting (offline) ───────────────────────
console.log('L1 · one-liners for the next meeting (offline)');
let A = null;
try { A = await importTs(new URL('supabase/functions/_shared/agenda.ts', root)); }
catch (e) { check('L1: the agenda rules exist', false, e.message.split('\n')[0]); }
if (A) {
  check('L1: an item is one line: extra spaces and line breaks become single spaces',
    A.cleanItem('  Bathrooms   have been\ncomplained about  ') === 'Bathrooms have been complained about', A.cleanItem('  Bathrooms   have been\ncomplained about  '));
  check('L1: up to 100 characters; longer is refused with a reason, empty too',
    A.itemProblem('x'.repeat(100)) === null && /100 characters/.test(A.itemProblem('x'.repeat(101)) || '') && /Write/.test(A.itemProblem('   ') || ''), '');
}
{
  const mig = exists('supabase/migrations/20261006000100_meeting_agenda.sql') ? read('supabase/migrations/20261006000100_meeting_agenda.sql') : '';
  check('L1: items are stored with who added them, 100 characters at most, one line',
    /create table if not exists public\.agenda_items/.test(mig) && /length\(body\) between 1 and 100/.test(mig) && /added_by_name/.test(mig), 'no migration');
  const bm = read('supabase/functions/board_meetings/index.ts');
  check('L1: the board can add, change and remove items, and see the list',
    ['next', 'add_item', 'update_item', 'delete_item'].every(a => bm.includes(`action === '${a}'`)), '');
  const page = read('club/admin/board-meetings.html');
  check('L1: the Board minutes page has the "Next meeting" card: one-line box with a counter, and the list',
    /id="next-card"/.test(page) && /maxlength="100"/.test(page) && /id="item-count"/.test(page) && /add_item/.test(page), '');
  check('L1: the dashboard\'s Board meeting card links straight to adding an item', /board-meetings\.html#add/.test(read('club/admin/index.html')), '');
}

// ── L2: create and view the agenda (offline) ────────────────────────────
console.log('\nL2 · create agenda (offline)');
if (A) {
  const positions = [{ id: 'p', title: 'President', sort: 0 }, { id: 'v', title: 'Vice-President', sort: 1 }, { id: 't', title: 'Treasurer', sort: 2 }, { id: 'g', title: 'Grounds Director', sort: 5 }];
  const holders = [{ position_id: 'p', admin_user_id: 'doug' }, { position_id: 't', admin_user_id: 'kris' }, { position_id: 'v', admin_user_id: 'kris' }];
  const logins = [{ id: 'doug', display_name: 'Doug Frevele' }, { id: 'kris', display_name: 'Kristin' }, { id: 'sam', display_name: 'Sam' }];
  const items = [
    { id: '1', body: 'Bathrooms have been complained about', added_by: 'kris', added_by_name: 'Kristin', created_at: '2026-10-06T10:00:00Z' },
    { id: '2', body: 'Close for the season Oct 18', added_by: 'doug', added_by_name: 'Doug Frevele', created_at: '2026-10-06T11:00:00Z' },
    { id: '3', body: 'New lounge chairs', added_by: 'sam', added_by_name: 'Sam', created_at: '2026-10-06T12:00:00Z', carried_from_date: '2026-09-12' },
    { id: '4', body: 'Old idea', added_by: null, added_by_name: 'Pat (left the board)', created_at: '2026-10-01T12:00:00Z' },
  ];
  const ag = A.buildAgenda({ meeting: { meeting_date: '2026-10-10', planned_time: '10:00', location: 'Clubhouse' }, positions, holders, logins, items,
    lastMinutesDate: '2026-09-12', openFollowUps: [{ description: 'Get 3 quotes on the pump', assigned_to: 'Facilities', due_date: '2026-10-01', meeting_date: '2026-09-12' }] });
  const reports = ag.sections.find(x => x.key === 'reports');
  check('L2: the agenda has the standard sections in order',
    ag.sections.map(x => x.key).join(',') === 'open,minutes,reports,old,actions,close', ag.sections.map(x => x.key).join(','));
  check('L2: each board member\'s items sit under their name, in board order',
    reports.people.map(p => `${p.name}:${p.titles.join('+')}:${p.items.map(i => i.id).join('')}`).join(' | ')
      === 'Doug Frevele:President:2 | Kristin:Vice-President+Treasurer:1 | Sam::3 | Pat (left the board)::4',
    reports.people.map(p => `${p.name}:${p.titles.join('+')}:${p.items.map(i => i.id).join('')}`).join(' | '));
  const text = A.agendaText(ag);
  check('L2: the written agenda reads like the format Doug saw',
    /^Board Meeting — Saturday, October 10 · 10:00 AM · Clubhouse/.test(text) && /2\. Approve the minutes of the September 12 meeting/.test(text)
      && /Kristin, Vice-President · Treasurer\n {5}- Bathrooms have been complained about/.test(text) && /New lounge chairs \(from September 12\)/.test(text)
      && /Get 3 quotes on the pump \(Facilities, due October 1\)/.test(text) && /6\. Set the next meeting, adjourn$/.test(text), text);
}
{
  const bm = read('supabase/functions/board_meetings/index.ts');
  check('L2: the board can create and view the agenda', /action === 'create_agenda'/.test(bm) && /action === 'agenda'/.test(bm) && /buildAgenda/.test(bm), '');
  const page = read('club/admin/board-meetings.html');
  check('L2: the page has Create agenda, a date/time/place form when nothing\'s planned, and the agenda view',
    /create_agenda/.test(page) && /id="agenda-scrim"/.test(page) && /id="plan-time"/.test(page) && /#agenda=/.test(page), '');
  check('L2: a meeting can have a start time', /id="m-time"/.test(page) && /planned_time/.test(between(page, 'async function saveNow', '\n}\n')), '');
}

// ── L3: send to the board (offline) ─────────────────────────────────────
console.log('\nL3 · send to the board (offline)');
if (A) {
  const sms = A.agendaSms ? A.agendaSms('Bishop Estates Cabana Club', '2026-10-10', '10:00', 'https://bishopestates.poolsideapp.com/club/admin/board-meetings.html#agenda=0f8b6a2c-1111-2222-3333-444455556666') : '';
  check('L3: the text says which meeting, when, and links to the agenda, in one plain-text message',
    /Bishop Estates Cabana Club: the agenda for the board meeting Saturday, October 10, 10:00 AM is up\./.test(sms) && /#agenda=/.test(sms)
      && sms.length <= 306 && /^[\x20-\x7e]*$/.test(sms), sms);
  const how = A.sendChannel;
  check('L3: each board member gets it their way: email if they chose email, else text, else email',
    how && how({ notify_pref: 'email', email: 'a@x.co', phone_e164: '+15551234567' }) === 'email'
      && how({ notify_pref: 'sms', email: 'a@x.co', phone_e164: '+15551234567' }) === 'text'
      && how({ notify_pref: 'sms', email: 'a@x.co', phone_e164: null }) === 'email'
      && how({ notify_pref: 'email', email: null, phone_e164: null }) === null, '');
}
{
  const bm = read('supabase/functions/board_meetings/index.ts');
  const send = between(bm, "action === 'send_agenda'", "// ── bylaws");
  check('L3: sending is its own action, with a preview, and records who sent it', /preview/.test(send) && /agenda_sent_at/.test(send) && /agenda_sent_by/.test(send), '');
  check('L3: it texts, emails and pops up for the whole board', /sendSms/.test(send) && /sendEmail/.test(send) && /pushBoard/.test(send) && /admin_ids/.test(send), '');
  check('L3: pop-ups can go to a named list of board members', /admin_ids/.test(read('supabase/functions/push_admin/index.ts')) && /admin_ids/.test(read('supabase/functions/_shared/task_routing.ts')), '');
  const page = read('club/admin/board-meetings.html');
  check('L3: "Send to the board" only on the button, with who\'ll get it how; "Send again" after', /send_agenda/.test(page) && /preview: true/.test(page) && /Send again/.test(page), '');
}

// ── L4: at the meeting (offline) ────────────────────────────────────────
console.log('\nL4 · at the meeting (offline)');
{
  const bm = read('supabase/functions/board_meetings/index.ts');
  check('L4: the note-taker checks items off', /action === 'cover_item'/.test(bm) && /editable\(/.test(between(bm, "action === 'cover_item'", 'return jsonResponse({ ok: true')), '');
  check('L4: closing the meeting sends anything not checked off back for the next one',
    /carried_from/.test(between(bm, "action === 'finalize'", "// ── delete")) && /covered', false\)/.test(between(bm, "action === 'finalize'", "// ── delete")), '');
  check('L4: starting a meeting brings in anything still waiting', /agenda_items/.test(between(bm, "action === 'start'", "action === 'update'")), '');
  const page = read('club/admin/board-meetings.html');
  check('L4: the meeting screen lists the agenda items with check boxes', /id="agenda-host"/.test(page) && /cover_item/.test(page), '');
}

const club = OFFLINE ? null : (await sql(`select id from tenants where slug = 'bishopestates'`))[0];
const owner = OFFLINE ? null : (await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`))[0];
const STAMP = String(Date.now()).slice(-6);
const tag = `[t${STAMP}]`;
const tok = id => jwt({ sub: id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
async function cleanup() {
  await sql(`delete from agenda_items where tenant_id = '${club.id}' and body like '%${tag}%'`);
  await sql(`delete from board_meetings where tenant_id = '${club.id}' and title like 'SimTest%'`);
  const { purgeTempAdmins } = await import('./lib/testdata.mjs');
  await purgeTempAdmins(sql, club.id);
}

if (live('L1')) {
  console.log('\nL1 · live (about 8 calls; temporary board logins and items, removed afterward)');
  const { makeTempAdmin } = await import('./lib/testdata.mjs');
  try {
    const a = await makeTempAdmin(sql, club.id, 'L1 Adder', [], 'custom');
    const b = await makeTempAdmin(sql, club.id, 'L1 Other', [], 'custom');
    const add = await fn('board_meetings', 'add_item', tok(a), { body: `  Bathrooms   have been\ncomplained about ${tag} ` });
    check('L1: any board member adds a one-liner; it\'s saved as one line, with their name',
      add.ok && add.item?.body === `Bathrooms have been complained about ${tag}` && /SimTest L1 Adder/.test(add.item?.added_by_name || ''), short(add));
    const long = await fn('board_meetings', 'add_item', tok(a), { body: 'x'.repeat(101) });
    check('L1: more than 100 characters is refused', long.status === 400 && /100 characters/.test(long.error || ''), short(long));
    const notMine = await fn('board_meetings', 'delete_item', tok(b), { id: add.item?.id });
    check('L1: someone else can\'t remove it', notMine.status === 403, short(notMine));
    const bAdd = await fn('board_meetings', 'add_item', tok(b), { body: `Pump quote ${tag}` });
    const list = await fn('board_meetings', 'next', tok(b));
    const mine = (list.items || []).filter(x => x.body.includes(tag));
    check('L1: the list shows everything waiting, who added it, and what each person can change',
      list.ok && mine.length === 2 && mine.find(x => x.id === add.item?.id)?.can_change === false && mine.find(x => x.id === bAdd.item?.id)?.can_change === true, short(mine));
    const edit = await fn('board_meetings', 'update_item', tok(b), { id: bAdd.item?.id, body: `Pump quotes are in ${tag}` });
    const pres = await fn('board_meetings', 'delete_item', jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' }), { id: add.item?.id });
    check('L1: people change their own; the president can remove anyone\'s', edit.ok && edit.item?.body === `Pump quotes are in ${tag}` && pres.ok, short({ edit: edit.error, pres: pres.error }));
  } finally {
    await cleanup();
    const [n] = await sql(`select count(*)::int as n from agenda_items where body like '%${tag}%'`);
    check('L1: test items and logins removed', n.n === 0, short(n));
  }
}

if (live('L2')) {
  console.log('\nL2 · live (about 8 calls; a test meeting, items and logins, removed afterward)');
  const { makeTempAdmin } = await import('./lib/testdata.mjs');
  let meetingId = null;
  try {
    const a = await makeTempAdmin(sql, club.id, 'L2 Adder', [], 'custom');
    const b = await makeTempAdmin(sql, club.id, 'L2 Reader', [], 'custom');
    await fn('board_meetings', 'add_item', tok(a), { body: `Bathrooms have been complained about ${tag}` });
    const noDate = await fn('board_meetings', 'create_agenda', tok(a), {});
    check('L2: with nothing planned, Create agenda asks for the date', noDate.status === 400 && /date/.test(noDate.error || ''), short(noDate));
    const date = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const made = await fn('board_meetings', 'create_agenda', tok(a), { meeting_date: date, planned_time: '10:00', location: 'SimTest Clubhouse' });
    meetingId = made.meeting?.id;
    const reports = (made.agenda?.sections || []).find(x => x.key === 'reports');
    const adder = reports?.people?.find(p => /L2 Adder/.test(p.name));
    check('L2: anyone on the board creates it; it plans the meeting and puts their item under their name',
      made.ok && made.meeting?.agenda_created_at && made.meeting?.planned_time === '10:00' && adder?.items?.some(it => it.body.includes(tag))
        && reports.people[0]?.titles?.includes('President'), short({ err: made.error, people: reports?.people?.map(p => p.name) }));
    await sql(`update board_meetings set title = 'SimTest Board Meeting' where id = '${meetingId}'`);
    await fn('board_meetings', 'add_item', tok(b), { body: `Late addition ${tag}` });
    const [late] = await sql(`select meeting_id from agenda_items where body = 'Late addition ${tag}'`);
    check('L2: something added after the agenda is made joins it', late?.meeting_id === meetingId, short(late));
    const view = await fn('board_meetings', 'agenda', tok(b), { meeting_id: meetingId });
    check('L2: any board member sees the agenda, with who made it',
      view.ok && /Late addition/.test(view.text || '') && /Bathrooms have been complained about/.test(view.text || '') && /L2 Adder/.test(view.created_by_name || ''),
      short({ err: view.error, by: view.created_by_name }));
    const pub = await fn('board_meetings', 'list_public', null, { slug: 'bishopestates' });
    check('L2: the agenda isn\'t on the public page', pub.ok && !JSON.stringify(pub).includes(tag), '');
  } finally {
    if (meetingId) await sql(`delete from board_meetings where id = '${meetingId}'`);
    await cleanup();
    const [n] = await sql(`select (select count(*) from agenda_items where body like '%${tag}%')::int as items,
      (select count(*) from board_meetings where location = 'SimTest Clubhouse')::int as meetings`);
    check('L2: test meeting, items and logins removed', n.items === 0 && n.meetings === 0, short(n));
  }
}

if (live('L3')) {
  // Preview only: a real send would text and email the real board.
  console.log('\nL3 · live, preview only (about 6 calls; nothing is sent)');
  const { makeTempAdmin } = await import('./lib/testdata.mjs');
  let meetingId = null, bare = null;
  try {
    const x = await makeTempAdmin(sql, club.id, 'L3 Texter', [], 'custom');
    const y = await makeTempAdmin(sql, club.id, 'L3 Emailer', [], 'custom');
    const z = await makeTempAdmin(sql, club.id, 'L3 Gate iPad', ['check_in'], 'gate_attendant');
    await sql(`update admin_users set notify_pref = 'sms', phone_e164 = '+1555${STAMP}1' where id = '${x}'`);
    await sql(`update admin_users set notify_pref = 'email' where id = '${y}'`);
    const plain = await fn('board_meetings', 'create', tok(x), { title: 'SimTest No Agenda', meeting_date: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10) });
    bare = plain.meeting?.id;
    const early = await fn('board_meetings', 'send_agenda', tok(x), { meeting_id: bare, preview: true });
    check('L3: nothing to send before the agenda is created', early.status === 409 && /Create the agenda/.test(early.error || ''), short(early));
    await fn('board_meetings', 'add_item', tok(x), { body: `Bathrooms ${tag}` });
    const made = await fn('board_meetings', 'create_agenda', tok(x), { meeting_id: bare });
    meetingId = made.meeting?.id;
    const pv = await fn('board_meetings', 'send_agenda', tok(y), { meeting_id: meetingId, preview: true });
    const ch = name => (pv.recipients || []).find(r => r.name.includes(name))?.channel;
    check('L3: it goes to every board member their way, and not to gate iPads',
      pv.ok && ch('L3 Texter') === 'text' && ch('L3 Emailer') === 'email' && ch('Doug') === 'email' && !ch('L3 Gate iPad'), short(pv.recipients));
    const [m] = await sql(`select agenda_sent_at from board_meetings where id = '${meetingId}'`);
    check('L3: a preview sends nothing and isn\'t recorded as sent', m && !m.agenda_sent_at, short(m));
  } finally {
    if (bare) await sql(`delete from board_meetings where id = '${bare}'`);
    await cleanup();
    const [n] = await sql(`select (select count(*) from board_meetings where title like 'SimTest%')::int as meetings,
      (select count(*) from agenda_items where body like '%${tag}%')::int as items`);
    check('L3: test meeting, items and logins removed', n.meetings === 0 && n.items === 0, short(n));
  }
}

if (live('L4')) {
  console.log('\nL4 · live (about 10 calls; a test meeting, items and logins, removed afterward)');
  const { makeTempAdmin } = await import('./lib/testdata.mjs');
  let meetingId = null;
  try {
    const n = await makeTempAdmin(sql, club.id, 'L4 Note Taker', [], 'custom');
    const o = await makeTempAdmin(sql, club.id, 'L4 Other', [], 'custom');
    const i1 = await fn('board_meetings', 'add_item', tok(n), { body: `Covered item ${tag}` });
    const i2 = await fn('board_meetings', 'add_item', tok(o), { body: `Not reached ${tag}` });
    const made = await fn('board_meetings', 'create_agenda', tok(n), { meeting_date: new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10), location: 'SimTest Room' });
    meetingId = made.meeting?.id;
    await sql(`update board_meetings set title = 'SimTest Agenda Meeting', visibility = 'private' where id = '${meetingId}'`);
    const started = await fn('board_meetings', 'start', tok(n), { id: meetingId });
    const notTaker = await fn('board_meetings', 'cover_item', tok(o), { id: i1.item?.id, covered: true });
    check('L4: only the note-taker (or the president) checks items off', started.ok && notTaker.status === 403, short({ started: started.error, notTaker }));
    const cov = await fn('board_meetings', 'cover_item', tok(n), { id: i1.item?.id, covered: true });
    const closed = await fn('board_meetings', 'finalize', tok(n), { id: meetingId });
    const rows = await sql(`select body, meeting_id, covered, carried_from from agenda_items where body like '%${tag}%' order by body`);
    const covered = rows.find(r => r.body.startsWith('Covered')), left = rows.find(r => r.body.startsWith('Not reached'));
    check('L4: checked-off items stay with the meeting; the rest go back on the list, marked where they came from',
      cov.ok && closed.ok && covered?.meeting_id === meetingId && covered?.covered === true && left?.meeting_id === null && left?.carried_from === meetingId, short(rows));
    const next = await fn('board_meetings', 'next', tok(o));
    const carried = (next.items || []).find(x => x.id === i2.item?.id);
    check('L4: the next meeting\'s list shows it as carried over', !!carried?.carried_from_date, short(carried));
  } finally {
    if (meetingId) await sql(`delete from board_meetings where id = '${meetingId}'`);
    await cleanup();
    const [c] = await sql(`select (select count(*) from board_meetings where title like 'SimTest%')::int as meetings,
      (select count(*) from agenda_items where body like '%${tag}%')::int as items`);
    check('L4: test meeting, items and logins removed', c.meetings === 0 && c.items === 0, short(c));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Targeted check for doors, access levels and passes (PLAN.md AR).
// Offline: loads _shared/access.ts and _shared/gate_doors.ts and reads the
// functions and pages. Costs nothing.
//
// Usage: node scripts/test_access.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
const TZ = 'America/Los_Angeles';

// Bishop's doors (PLAN.md AK) plus the two restrooms, keyfob only (AR1).
const DOORS = [
  { key: 'main_gate', name: 'Main Gate', controller: 423141044, address: '10.1.10.153', door: 1 },
  { key: 'snack', name: 'Snack', controller: 423141044, address: '10.1.10.153', door: 2 },
  { key: 'pump_room', name: 'Pump Room', controller: 423150481, address: '10.1.10.173', door: 1 },
  { key: 'swim_shack', name: 'Swim Shack', controller: 423150481, address: '10.1.10.173', door: 2 },
  { key: 'mens', name: 'Mens', controller: 423150481, address: '10.1.10.173', door: 3, remote: false },
  { key: 'womens', name: 'Womens', controller: 423150481, address: '10.1.10.173', door: 4, remote: false },
];
const BISHOP = { access: { levels: [
  { key: 'member', name: 'Member', doors: ['main_gate', 'mens', 'womens'], days: [0, 1, 2, 3, 4, 5, 6], start: '06:00', end: '20:30', until: '2026-10-31' },
  { key: 'board', name: 'Board', doors: ['main_gate', 'snack', 'pump_room', 'swim_shack', 'mens', 'womens'], days: [0, 1, 2, 3, 4, 5, 6], start: null, end: null, until: null },
], party_doors: ['snack'] }, pool: { opens_at: '08:00', closes_at: '20:00', hours_by_day: { 0: null, 6: { opens: '09:00', closes: '19:00', closed: false } } } };

console.log('AR1 · the club\'s doors');
let gd = null;
try { gd = await importTs(new URL('supabase/functions/_shared/gate_doors.ts', root)); } catch (e) { check('gate_doors loads', false, e.message); }
if (gd) {
  check('the restrooms are on the list as keyfob-only doors', gd.doorsFor(DOORS).map(d => d.key).join() === 'main_gate,snack,pump_room,swim_shack,mens,womens'
    && gd.doorsFor(DOORS).find(d => d.key === 'mens').remote === false, JSON.stringify(gd.doorsFor(DOORS).find(d => d.key === 'mens')));
  check('keyfob-only doors never get an Unlock button', gd.openableDoors(DOORS, '1.3.0-poolside').map(d => d.key).join() === 'main_gate,snack,pump_room,swim_shack');
  check('and can\'t be opened remotely', gd.findDoor(DOORS, 'mens') === null && gd.findDoor(DOORS, 'snack')?.key === 'snack');
  check('the unlock log still names them', gd.doorName(DOORS, 'womens') === 'Womens');
}
const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /access_levels(_bishop)?\.sql$/.test(f));
const sql = mig.map(f => read(`supabase/migrations/${f}`)).join('\n');
check('a migration adds passes, a level on each fob, and the pass on each unlock',
  /create table if not exists public\.access_passes/i.test(sql) && /keyfobs[\s\S]*add column if not exists level/i.test(sql) && /gate_unlocks[\s\S]*add column if not exists pass_id/i.test(sql), mig.join());
check('Bishop gets the restrooms (keyfob only), its two levels and the Snack Shack for parties',
  /"mens"[^}]*"remote":\s*false/.test(sql.replace(/\s+/g, ' ')) && /06:00/.test(sql) && /20:30/.test(sql) && /"party_doors":\s*\["snack"\]/.test(sql.replace(/\s+/g, ' ')));
check('passes are private like every table (row security on)', /alter table public\.access_passes enable row level security/i.test(sql));

console.log('AR2 · access levels');
let A = null;
try { A = await importTs(new URL('supabase/functions/_shared/access.ts', root)); } catch (e) { check('the rules live in _shared/access.ts', false, e.message); }
if (A) {
  const c = A.accessConfig(BISHOP, DOORS);
  check('Bishop: Member and Board', c.levels.map(l => l.name).join() === 'Member,Board');
  const d = A.accessConfig({}, DOORS);
  check('a club that set nothing: members get the front gate any time, the board every door',
    d.levels[0].key === 'member' && d.levels[0].doors.join() === 'main_gate' && !d.levels[0].start && d.levels[1].doors.length === 6 && d.party_doors.length === 0, JSON.stringify(d));
  check('a level reads plainly', A.describeLevel(c.levels[0], DOORS) === 'Main Gate, Mens, Womens · every day 6:00 AM–8:30 PM · until Oct 31, 2026', A.describeLevel(c.levels[0], DOORS));
  check('the board level reads plainly', A.describeLevel(c.levels[1], DOORS) === 'Every door · any time', A.describeLevel(c.levels[1], DOORS));
  const m = c.levels[0];
  const at = iso => A.levelOpenAt(m, TZ, new Date(iso));
  check('5:59 AM at the pool: closed, opens at 6:00 AM', !at('2026-10-13T12:59:00Z').open && at('2026-10-13T12:59:00Z').opens === '6:00 AM', JSON.stringify(at('2026-10-13T12:59:00Z')));
  check('6:00 AM: open', at('2026-10-13T13:00:00Z').open);
  check('8:29 PM: open; 8:30 PM: closed', at('2026-10-14T03:29:00Z').open && !at('2026-10-14T03:30:00Z').open);
  check('after the level\'s last day it\'s closed', !at('2026-11-01T18:00:00Z').open && at('2026-11-01T18:00:00Z').why === 'ended');
  const weekdays = { ...m, days: [1, 2, 3, 4, 5], until: null };
  check('a day it isn\'t on is closed (Sunday, for a weekday level)', !A.levelOpenAt(weekdays, TZ, new Date('2026-10-18T18:00:00Z')).open);
  check('the board level is always open', A.levelOpenAt(c.levels[1], TZ, new Date('2026-10-14T10:00:00Z')).open);
  const bad = A.cleanAccess({ levels: [{ ...m, doors: ['main_gate', 'nope'], start: '25:00' }, c.levels[1]], party_doors: ['snack'] }, DOORS);
  check('saving refuses a bad time', !bad.ok, JSON.stringify(bad));
  const good = A.cleanAccess({ levels: [{ ...m, doors: ['main_gate', 'nope'], start: '07:00' }, c.levels[1]], party_doors: ['snack', 'mens'] }, DOORS);
  check('saving keeps only doors on file, and parties only get doors that open remotely',
    good.ok && good.value.levels[0].doors.join() === 'main_gate' && good.value.levels[0].start === '07:00' && good.value.party_doors.join() === 'snack', JSON.stringify(good));

  console.log('AR3/AR4 · what a member can open now');
  const noon = new Date('2026-10-13T19:00:00Z'), late = new Date('2026-10-14T04:00:00Z');   // noon, 9 PM at the pool
  const pass = { id: 'p1', doors: ['pump_room', 'mens'], starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z', ended_at: null };
  const now1 = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0-poolside', passes: [], tz: TZ, now: noon });
  check('at noon a member can open the front gate', now1.doors.map(x => x.key).join() === 'main_gate' && !now1.gateClosed, JSON.stringify(now1));
  const now2 = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0-poolside', passes: [], tz: TZ, now: late });
  check('at 9 PM the front gate is closed to members, and the app says when it opens', !now2.doors.length && now2.gateClosed?.opens === '6:00 AM' && now2.gateClosed?.hours === '6:00 AM–8:30 PM', JSON.stringify(now2));
  const now3 = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0-poolside', passes: [pass], tz: TZ, now: late });
  check('a pass opens its doors outside member hours (keyfob-only doors left out)', now3.doors.map(x => x.key).join() === 'pump_room' && now3.doors[0].pass_id === 'p1', JSON.stringify(now3));
  const all = { ...pass, doors: ['main_gate', 'snack', 'pump_room', 'swim_shack'] };
  const now4 = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0-poolside', passes: [all], tz: TZ, now: late });
  check('an all-access pass opens the front gate after hours too', now4.doors.map(x => x.key).join() === 'main_gate,snack,pump_room,swim_shack' && !now4.gateClosed, JSON.stringify(now4.doors.map(x => x.key)));
  check('a pass that ended, or was ended early, opens nothing', !A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0-poolside', passes: [{ ...pass, ended_at: '2026-10-13T16:00:00Z' }], tz: TZ, now: late }).doors.length
    && !A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0-poolside', passes: [pass], tz: TZ, now: new Date('2026-10-14T06:00:00Z') }).doors.length);
  check('a gate computer before 1.2 only opens the front gate', A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.1.0-poolside', passes: [all], tz: TZ, now: noon }).doors.map(x => x.key).join() === 'main_gate');
  check('a pass needs doors, a start before its end, an end still to come, and at most a year',
    A.validatePass({ doors: [], starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z' }, DOORS, noon).ok === false
    && A.validatePass({ doors: ['snack'], starts_at: '2026-10-14T05:00:00Z', ends_at: '2026-10-13T15:00:00Z' }, DOORS, noon).ok === false
    && A.validatePass({ doors: ['snack'], starts_at: '2026-10-01T15:00:00Z', ends_at: '2026-10-02T05:00:00Z' }, DOORS, noon).ok === false
    && A.validatePass({ doors: ['snack'], starts_at: '2026-10-13T15:00:00Z', ends_at: '2028-10-13T15:00:00Z' }, DOORS, noon).ok === false
    && A.validatePass({ doors: ['snack', 'mens'], starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z' }, DOORS, noon).ok === false
    && A.validatePass({ doors: ['snack', 'pump_room'], starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z' }, DOORS, noon).ok === true);

  console.log('AR5 · parties');
  const w = A.partyPassWindow({ startsAt: '2026-10-17T21:00:00Z', endsAt: '2026-10-18T00:00:00Z', pool: BISHOP.pool, memberLevel: m, tz: TZ });   // Sat 2–5 PM
  check('a Saturday party: the pool\'s Saturday hours (9 AM–7 PM)', w.starts_at === '2026-10-17T16:00:00.000Z' && w.ends_at === '2026-10-18T02:00:00.000Z', JSON.stringify(w));
  const w2 = A.partyPassWindow({ startsAt: '2026-10-15T21:00:00Z', endsAt: '2026-10-16T00:00:00Z', pool: BISHOP.pool, memberLevel: m, tz: TZ });   // Thu
  check('a Thursday party: the usual hours (8 AM–8 PM)', w2.starts_at === '2026-10-15T15:00:00.000Z' && w2.ends_at === '2026-10-16T03:00:00.000Z', JSON.stringify(w2));
  const w3 = A.partyPassWindow({ startsAt: '2026-10-16T02:00:00Z', endsAt: '2026-10-16T04:30:00Z', pool: BISHOP.pool, memberLevel: m, tz: TZ });   // Thu 7–9:30 PM
  check('a party running past closing keeps its access to the end of the party', w3.ends_at === '2026-10-16T04:30:00.000Z', JSON.stringify(w3));
}

console.log('AR · the functions');
const ug = read('supabase/functions/unlock_gate/index.ts');
check('the member Unlock checks the Member hours and passes', /memberDoorsNow\(/.test(ug) && /body\.door/.test(ug) && /pass_id/.test(ug) && /door_key/.test(ug));
check('outside member hours it says when the gate opens', /after_hours/.test(ug) && /gateClosed/.test(ug));
check('"check" tells the app which doors to show', /doors:\s*now\.doors|doors: now\.doors/.test(between(ug, "action === 'check'", "action === 'tap'")));
const ga = read('supabase/functions/gate_admin/index.ts');
const passes = between(ga, "action === 'pass_list'", "action === 'test_unlock'");
check('any board member can list, give and end passes', /pass_create/.test(passes) && /pass_end/.test(passes) && /pass_families/.test(passes) && /boardMember\(/.test(passes));
check('a pass is checked before it\'s saved', /validatePass\(/.test(passes));
check('the family hears about a pass (pop-up)', /pushMembers|pushFamily|memberNotify|notifyHousehold/.test(passes));
const kf = read('supabase/functions/keyfobs/index.ts');
check('the Keyfobs tab saves levels and sets a fob\'s level', /action === 'levels_save'/.test(kf) && /cleanAccess\(/.test(kf) && /action === 'set_level'/.test(kf));
check('the keyfob list carries the levels and each fob\'s level', /accessConfig\(/.test(between(kf, "action === 'list'", "action === 'issue'")) && /level/.test(between(kf, 'const FIELDS', '\n')));
const pb = read('supabase/functions/_shared/party_booked.ts');
check('a paid party gives its family the party doors for the day', /givePartyPass\(/.test(pb));
const pa = read('supabase/functions/parties_admin/index.ts');
check('a canceled or rejected party loses it', /endPartyPass\(/.test(between(pa, "action === 'cancel_admin'", 'Unknown action')) && /endPartyPass\(/.test(between(pa, "status: 'rejected'", "action === '")));

console.log('AR · the pages');
const page = read('club/admin/keyfobs.html');
check('the Keyfobs tab has Access: each level\'s doors, days, hours and end date, and the party doors',
  /id="access-host"/.test(page) && /levels_save/.test(page) && /type="time"/.test(page) && /type="date"/.test(page) && /party_doors/.test(page));
check('each fob shows its level and can be switched', /set_level/.test(page) && /describeLevel|level-sum/.test(page));
check('the Keyfobs tab and the board home share the passes panel', /<script src="\/js\/passes\.js"><\/script>/.test(page) && /PoolsidePasses\.mount\(/.test(page)
  && /<script src="\/js\/passes\.js"><\/script>/.test(read('club/admin/index.html')) && /PoolsidePasses\.open\(/.test(read('club/admin/index.html')));
const pj = (() => { try { return read('js/passes.js'); } catch { return ''; } })();
check('the panel gives a pass: family, doors (or all of them), from, to, a note; and ends one early',
  /pass_create/.test(pj) && /pass_end/.test(pj) && /All doors/.test(pj) && /datetime-local/.test(pj) && /PoolTime\.fromInput/.test(pj));
const mi = read('m/index.html');
const card = between(mi, 'async function loadGateCard', 'function resetUnlockBtn');
check('the member app shows a button for each door they can open now', /r\.doors/.test(card) && /data-door/.test(card) && /callMember\('tap', \{ door/.test(card));
check('and after hours says when the gate opens', /after_hours/.test(card));

console.log('AS1 · Keyfobs & Access');
check('the tab is "Keyfobs & Access", only for clubs with keyfobs', /label: 'Keyfobs & Access'[^}]*feature: 'keyfobs'/.test(read('js/admin-subtabs.js')));
check('the page says so too', /<title>Keyfobs &amp; Access/.test(page) && /<h1>Keyfobs &amp; Access<\/h1>/.test(page));

console.log('AS2 · start and stop dates, and "the pool is closed"');
if (A) {
  const c = A.accessConfig({ access: { levels: [{ key: 'member', name: 'Member', doors: ['main_gate'], days: [0,1,2,3,4,5,6], start: '06:00', end: '20:30', from: '2027-05-23', until: '2027-10-31' }] } }, DOORS);
  const m = c.levels[0];
  check('a level keeps its first day', m.from === '2027-05-23');
  check('a level reads with its dates', A.describeLevel(m, DOORS) === 'Main Gate · every day 6:00 AM–8:30 PM · May 23–Oct 31, 2027', A.describeLevel(m, DOORS));
  const pre = A.levelOpenAt(m, TZ, new Date('2027-04-01T19:00:00Z'));
  check('before its first day it\'s closed and says when it starts', !pre.open && pre.why === 'not_started' && pre.starts === 'May 23', JSON.stringify(pre));
  check('saving refuses a first day after the last', !A.cleanAccess({ levels: [{ ...m, from: '2027-11-01' }] }, DOORS).ok);
  const night = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0', passes: [], tz: TZ, now: new Date('2027-06-02T05:00:00Z') });   // 10 PM Jun 1
  check('at night: "The pool is closed. It opens tomorrow at 6:00 AM."', night.gateClosed?.message === 'The pool is closed. It opens tomorrow at 6:00 AM.', night.gateClosed?.message);
  const early = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0', passes: [], tz: TZ, now: new Date('2027-06-02T12:00:00Z') });  // 5 AM Jun 2
  check('before opening: "The pool is closed. It opens at 6:00 AM."', early.gateClosed?.message === 'The pool is closed. It opens at 6:00 AM.', early.gateClosed?.message);
  const pre2 = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0', passes: [], tz: TZ, now: new Date('2027-04-01T19:00:00Z') });
  check('before the season: "Member access starts May 23."', pre2.gateClosed?.message === 'Member access starts May 23.', pre2.gateClosed?.message);
  const post = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0', passes: [], tz: TZ, now: new Date('2027-11-05T19:00:00Z') });
  check('after the last day: "The pool is closed for the season."', post.gateClosed?.message === 'The pool is closed for the season.', post.gateClosed?.message);
  const off = A.memberDoorsNow({ config: c, doorsRaw: DOORS, bridgeVersion: '1.3.0', passes: [], tz: TZ, now: new Date('2027-06-02T19:00:00Z'), season: { open: false, closed_message: 'See you Memorial Day weekend!' } });
  check('the Season switch off: closed for the season, with the club\'s message, even at noon', !off.doors.length && off.gateClosed?.message === 'The pool is closed for the season. See you Memorial Day weekend!', off.gateClosed?.message);
  const wk = { ...m, days: [1, 2, 3, 4, 5] };
  const sat = A.memberDoorsNow({ config: { ...c, levels: [wk] }, doorsRaw: DOORS, bridgeVersion: '1.3.0', passes: [], tz: TZ, now: new Date('2027-06-05T19:00:00Z') });   // Saturday noon
  check('a day it\'s closed: "It opens Monday at 6:00 AM."', sat.gateClosed?.message === 'The pool is closed. It opens Monday at 6:00 AM.', sat.gateClosed?.message);
  const b = A.boardOpenNow({ levels: [{ key: 'board', name: 'Board', doors: ['main_gate'], days: [0,1,2,3,4,5,6], start: null, end: null, from: null, until: null }], party_doors: [] }, TZ, new Date('2027-01-01T08:00:00Z'));
  check('the board is open any time unless its level says otherwise', b.open === true);
}
check('the board unlock follows the Board level', /boardOpenNow\(/.test(between(ga, "action === 'board_unlock'", "action === 'test_unlock'")));
check('the member app shows why it\'s closed instead of a button', /gc\.message/.test(card));

console.log('AS3 · text a pass, to members and guests');
const mig3 = readdirSync(new URL('supabase/migrations/', root)).filter(f => /guest_passes|keyfob_sync/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
check('a pass can be for a guest: name, mobile, a private link (stored hashed), no family',
  /access_passes[\s\S]*alter column household_id drop not null/i.test(mig3) && /guest_name/.test(mig3) && /guest_phone/.test(mig3) && /token_hash/.test(mig3));
check('guest unlocks are logged as guests', /actor_kind[\s\S]*'guest'/.test(mig3));
if (A) {
  check('a pass is upcoming, now, or ended', A.passState({ starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z' }, new Date('2026-10-13T14:00:00Z')) === 'upcoming'
    && A.passState({ starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z' }, new Date('2026-10-13T16:00:00Z')) === 'now'
    && A.passState({ starts_at: '2026-10-13T15:00:00Z', ends_at: '2026-10-14T05:00:00Z', ended_at: '2026-10-13T15:30:00Z' }, new Date('2026-10-13T16:00:00Z')) === 'ended');
}
const create = between(ga, "if (action === 'pass_create')", '// pass_end');
check('giving a pass to a guest needs a name and a mobile, and texts them a private link', /guest_name/.test(create) && /normalizePhone|toE164|phoneE164/.test(create) && /pass\.html\?t=/.test(create) && /sendSms\(/.test(create));
check('a member family gets a text too when "Text it" is ticked', /body\.text/.test(create));
check('the link is stored only as a hash', /token_hash/.test(create) && /sha256/i.test(create));
const ugx = read('supabase/functions/unlock_gate/index.ts');
const guest = between(ugx, "action === 'pass_info'", 'const authHdr');
check('the guest link works without signing in: info, open, status', /pass_info/.test(ugx) && /pass_tap/.test(ugx) && /pass_status/.test(ugx) && ugx.indexOf("'pass_info'") < ugx.indexOf('verifyMember(token)'));
check('a guest can only open the pass\'s doors, only during it', /passState\(/.test(ugx) && /actor_kind: 'guest'/.test(ugx));
const passPage = (() => { try { return read('pass.html'); } catch { return ''; } })();
check('the guest page shows the doors with Unlock buttons only during the pass', /pass_info/.test(passPage) && /pass_tap/.test(passPage) && /data-door/.test(passPage) && /upcoming/.test(passPage) && /ended/.test(passPage));
check('the passes panel gives a pass to a family or someone else, and can text it', /Someone else/.test(pj) && /guest_phone/.test(pj) && /Text it/.test(pj));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

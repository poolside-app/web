#!/usr/bin/env node
// Targeted check for opening each door (PLAN.md AK). Offline: loads the
// door rules from _shared/gate_doors.ts and reads the functions, the board
// home and the bridge. Costs nothing. The bridge itself is checked against
// a fake cloud and a fake controller by scripts/test_gate_poll.mjs.
//
// Usage: node scripts/test_gate_doors.mjs
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

// Bishop's wired doors (Doug, 10/12). Mens and Womens aren't wired yet.
const BISHOP = [
  { key: 'main_gate', name: 'Main Gate', controller: 423141044, address: '10.1.10.153', door: 1 },
  { key: 'snack', name: 'Snack', controller: 423141044, address: '10.1.10.153', door: 2 },
  { key: 'pump_room', name: 'Pump Room', controller: 423150481, address: '10.1.10.173', door: 1 },
  { key: 'swim_shack', name: 'Swim Shack', controller: 423150481, address: '10.1.10.173', door: 2 },
];

console.log('AK1 · the doors on file');
let gd = null;
try { gd = await importTs(new URL('supabase/functions/_shared/gate_doors.ts', root)); }
catch (e) { check('the door rules live in _shared/gate_doors.ts', false, e.message); }
if (gd) {
  const keys = l => l.map(d => d.key).join(',');
  check('a club with no list has just the front gate', keys(gd.doorsFor(undefined)) === 'main_gate' && keys(gd.doorsFor([])) === 'main_gate'
    && gd.doorsFor(null)[0].name === 'Front gate', JSON.stringify(gd.doorsFor(undefined)));
  check("Bishop's list gives the four wired doors, the Main Gate first", keys(gd.doorsFor(BISHOP)) === 'main_gate,snack,pump_room,swim_shack',
    keys(gd.doorsFor(BISHOP)));
  const bad = [
    ...BISHOP.slice(1),
    { key: 'mens', name: 'Mens', controller: 423150481, address: '10.1.10.173', door: 5 },         // no door 5
    { key: 'womens', name: 'Womens', controller: 0, address: '10.1.10.173', door: 4 },              // no controller
    { key: 'shed', name: 'Shed', controller: 423150481, address: 'not-an-ip', door: 3 },            // bad address
    { key: 'Bad Key', name: 'X', controller: 423150481, address: '10.1.10.173', door: 3 },
    { key: 'office', name: '', controller: 423150481, address: '10.1.10.173', door: 3 },            // no name
    { key: 'snack', name: 'Snack again', controller: 423141044, address: '10.1.10.153', door: 3 },  // same key twice
    BISHOP[0],
  ];
  check('bad entries are dropped and the Main Gate still comes first', keys(gd.doorsFor(bad)) === 'main_gate,snack,pump_room,swim_shack', keys(gd.doorsFor(bad)));
  check('a list without the front gate gets it added first', keys(gd.doorsFor(BISHOP.slice(1))) === 'main_gate,snack,pump_room,swim_shack');
  check('an address may carry the port', gd.doorsFor([{ key: 'snack', name: 'Snack', controller: 1, address: '10.1.10.153:60000', door: 2 }]).length === 2);

  console.log('AK3 · only a 1.2 bridge gets the other doors');
  check('1.1 and unknown versions: Main Gate only', !gd.doorsReady('1.1.0-poolside') && !gd.doorsReady(null) && !gd.doorsReady('') && !gd.doorsReady('garbage'));
  check('1.2 and later: every door', gd.doorsReady('1.2.0-poolside') && gd.doorsReady('1.10.0') && gd.doorsReady('2.0.0'));
  check('openable doors follow the bridge', keys(gd.openableDoors(BISHOP, '1.1.0-poolside')) === 'main_gate'
    && keys(gd.openableDoors(BISHOP, '1.2.0-poolside')) === 'main_gate,snack,pump_room,swim_shack');
  check('a missing door key means the front gate', gd.findDoor(BISHOP, undefined)?.key === 'main_gate' && gd.findDoor(BISHOP, '')?.key === 'main_gate');
  check('an unknown door is refused (null)', gd.findDoor(BISHOP, 'mens') === null && gd.findDoor(BISHOP, 'nope') === null);
  const cmd = gd.commandDoor(gd.findDoor(BISHOP, 'swim_shack'));
  check('the bridge is told the controller, its address and the door', cmd && cmd.controller === 423150481 && cmd.address === '10.1.10.173' && cmd.door === 2 && cmd.key === 'swim_shack', JSON.stringify(cmd));
  check('the front gate goes the proven way (no controller details)', gd.commandDoor(gd.findDoor(BISHOP, 'main_gate'))?.controller === undefined
    && gd.commandDoor(gd.findDoor(BISHOP, 'main_gate'))?.key === 'main_gate');
  check('an older bridge is only handed front-gate unlocks', /door_key\.is\.null/.test(gd.OLD_BRIDGE_DOORS) && /door_key\.eq\.main_gate/.test(gd.OLD_BRIDGE_DOORS));
  check('the log names the door', gd.doorName(BISHOP, 'pump_room') === 'Pump Room' && gd.doorName(BISHOP, null) === 'Main Gate' && gd.doorName([], null) === 'Front gate');
}

const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /gate_doors\.sql$/.test(f));
const migSql = mig.length ? read(`supabase/migrations/${mig[0]}`) : '';
check('a migration adds gate_panels.doors and gate_unlocks.door_key', /gate_panels[\s\S]*add column if not exists doors jsonb/i.test(migSql) && /gate_unlocks[\s\S]*add column if not exists door_key/i.test(migSql), mig.join(','));
check("it lists Bishop's four wired doors and not Mens or Womens",
  ['Main Gate', 'Snack', 'Pump Room', 'Swim Shack', '423141044', '423150481'].every(s => migSql.includes(s)) && !/Mens|Womens/.test(migSql.replace(/--.*$/gm, '')));

console.log('AK2 · the board home');
let bh = null;
try { bh = await importTs(new URL('supabase/functions/_shared/board_home.ts', root)); } catch (e) { check('board_home loads', false, e.message); }
if (bh) {
  const now = new Date().toISOString();
  const panel = v => ({ status: 'active', panel_host: '10.1.10.153', bridge_last_seen_at: now, bridge_version: v, doors: BISHOP });
  const f = { keyfobs: true, gate: true };
  const caller = { isOwner: false, scopes: [] };
  const g11 = bh.gateCard(f, panel('1.1.0-poolside'), caller), g12 = bh.gateCard(f, panel('1.2.0-poolside'), caller);
  check('with bridge 1.1 the card has the Main Gate only', g11.show && (g11.doors || []).map(d => d.key).join() === 'main_gate', JSON.stringify(g11));
  check('with bridge 1.2 every board member gets all four doors', (g12.doors || []).map(d => d.name).join() === 'Main Gate,Snack,Pump Room,Swim Shack', JSON.stringify(g12));
  check('the card sends names and keys only (no addresses)', !JSON.stringify(g12).includes('10.1.10.'));
  const bhSrc = read('supabase/functions/_shared/board_home.ts');
  check('the home reads the doors and the bridge version', /from\('gate_panels'\)\.select\([^)]*doors[^)]*bridge_version|from\('gate_panels'\)\.select\([^)]*bridge_version[^)]*doors/.test(bhSrc));
}
const ga = read('supabase/functions/gate_admin/index.ts');
const bu = between(ga, "action === 'board_unlock'", "action === 'test_unlock'");
check('board_unlock takes the door', /body\.door/.test(bu) && /findDoor\(/.test(bu));
check('it refuses a door that is not on the list', /findDoor\([\s\S]{0,200}400/.test(bu));
check('it refuses another door until the bridge is 1.2', /doorsReady\([\s\S]{0,300}409/.test(bu));
check('it records the door', /door_key:\s*door\.key/.test(bu));
check('the board unlock reads the doors and the bridge version', /select\('[^']*doors[^']*'\)/.test(bu) && /select\('[^']*bridge_version[^']*'\)/.test(bu));
const ug = read('supabase/functions/unlock_gate/index.ts');
check('members: the front gate only (unlock_gate never takes a door)', !/door_key|body\.door/.test(ug));
const home = read('club/admin/index.html');
check('the board home draws a button per door', /home\.gate\.doors/.test(home) && /data-door/.test(home));
check('a tap sends that door', /action:\s*'board_unlock',\s*door/.test(home));

console.log('AK3 · the cloud hands the bridge its door');
const gb = read('supabase/functions/gate_bridge/index.ts');
const poll = between(gb, "action === 'poll'", "action === 'complete'");
check('an older bridge only claims front-gate unlocks', /doorsReady\(/.test(poll) && /OLD_BRIDGE_DOORS/.test(poll));
check('the command carries the door', /door:\s*commandDoor\(/.test(poll));
check('the bridge check-in reads the doors', /select\('[^']*doors[^']*'\)/.test(gb) && /door_key/.test(poll));
const py = read('bridge/gate_bridge.py');
check('the bridge is version 1.2', /BRIDGE_VERSION\s*=\s*"1\.2/.test(py));
check('it opens the other doors with uhppoted open_door', /open_door\(/.test(py) && /import uhppoted|from uhppoted/.test(py));

console.log('AK4 · the unlock log');
const ru = between(ga, "action === 'recent_unlocks'", "action === 'board_unlock'");
check('recent unlocks include the door and who on the board opened it', /door_key/.test(ru) && /admin_user_id/.test(ru) && /admin_users/.test(ru));
const st = read('club/admin/settings.html');
const lru = between(st, 'async function loadRecentUnlocks', '\n}\n');
check('Settings shows the door and the board member', /door_name/.test(lru) && /admin_name/.test(lru));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

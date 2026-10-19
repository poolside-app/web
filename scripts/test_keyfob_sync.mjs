#!/usr/bin/env node
// Targeted check for the keyfob sync (PLAN.md AS4): what Poolside wants on
// each controller, how that's compared with what's there, and the wiring.
// Offline: loads _shared/keyfob_sync.ts and reads the functions, the bridge
// and the page. The bridge's reading and writing is checked against a fake
// controller by scripts/test_gate_bridge_loop.py. Costs nothing.
//
// Usage: node scripts/test_keyfob_sync.mjs
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

const DOORS = [
  { key: 'main_gate', name: 'Main Gate', controller: 423141044, address: '10.1.10.153', door: 1 },
  { key: 'snack', name: 'Snack', controller: 423141044, address: '10.1.10.153', door: 2 },
  { key: 'pump_room', name: 'Pump Room', controller: 423150481, address: '10.1.10.173', door: 1 },
  { key: 'swim_shack', name: 'Swim Shack', controller: 423150481, address: '10.1.10.173', door: 2 },
  { key: 'mens', name: 'Mens', controller: 423150481, address: '10.1.10.173', door: 3, remote: false },
  { key: 'womens', name: 'Womens', controller: 423150481, address: '10.1.10.173', door: 4, remote: false },
];
const CONFIG = { party_doors: ['snack'], levels: [
  { key: 'member', name: 'Member', doors: ['main_gate', 'mens', 'womens'], days: [0, 1, 2, 3, 4, 5, 6], start: '06:00', end: '20:30', from: '2027-05-23', until: '2027-10-31' },
  { key: 'board', name: 'Board', doors: DOORS.map(d => d.key), days: [0, 1, 2, 3, 4, 5, 6], start: null, end: null, from: null, until: null },
] };
const FOBS = [
  { id: 'f1', household_id: 'h1', family_name: 'Garcia', status: 'active', card_number: 786777, level: 'member' },
  { id: 'f2', household_id: 'h2', family_name: 'Nguyen', status: 'active', card_number: 800001, level: 'board' },
  { id: 'f3', household_id: 'h1', family_name: 'Garcia', status: 'off', card_number: 700001, level: 'member' },
  { id: 'f4', household_id: 'h1', family_name: 'Garcia', status: 'lost', card_number: 700002, level: 'member' },
  { id: 'f5', household_id: 'h3', family_name: 'Kim', status: 'requested', card_number: null, level: 'member' },
];

console.log('AS4 · what Poolside wants on the doors');
let K = null;
try { K = await importTs(new URL('supabase/functions/_shared/keyfob_sync.ts', root)); } catch (e) { check('the rules live in _shared/keyfob_sync.ts', false, e.message); }
if (K) {
  const plan = K.syncPlan({ fobs: FOBS, config: CONFIG, doorsRaw: DOORS });
  check('both controllers, with their addresses', plan.controllers.map(c => `${c.serial}@${c.address}`).join() === '423141044@10.1.10.153,423150481@10.1.10.173');
  const card = (n, c) => plan.cards.find(x => x.card === n && x.controller === c);
  check('a member fob: the Main Gate on the snack shack controller, on the Member hours', JSON.stringify(card(786777, 423141044).want) === JSON.stringify({ from: '2027-05-23', to: '2027-10-31', doors: [2, 0, 0, 0] }), JSON.stringify(card(786777, 423141044)));
  check('and the restrooms on the pump room controller', JSON.stringify(card(786777, 423150481).want.doors) === '[0,0,2,2]', JSON.stringify(card(786777, 423150481)));
  check('a board fob: every door, any time, no end', JSON.stringify(card(800001, 423141044).want) === JSON.stringify({ from: '2020-01-01', to: '2099-12-31', doors: [1, 1, 0, 0] }) && JSON.stringify(card(800001, 423150481).want.doors) === '[1,1,1,1]', JSON.stringify(card(800001, 423141044)));
  check('turned-off and lost fobs come off both controllers', card(700001, 423141044).want === null && card(700002, 423150481).want === null);
  check('a fob without a number yet is left out', !plan.cards.some(c => c.fob_id === 'f5'));
  check('each card says whose it is', card(786777, 423141044).family === 'Garcia');
  const prof = plan.profiles.filter(p => p.id === 2);
  check('the Member hours become time window 2 on each controller', prof.length === 2 && JSON.stringify(prof[0].want) === JSON.stringify({ from: '2027-05-23', to: '2027-10-31', days: [true, true, true, true, true, true, true], start: '06:00', end: '20:30' }), JSON.stringify(prof[0]));
  check('a level open any time needs no window (door value 1)', !plan.profiles.some(p => p.id === 3));
  const weekdays = { ...CONFIG, levels: [{ ...CONFIG.levels[0], days: [1, 2, 3, 4, 5], start: null, end: null }, CONFIG.levels[1]] };
  const wp = K.syncPlan({ fobs: FOBS, config: weekdays, doorsRaw: DOORS }).profiles.find(p => p.id === 2);
  check('a level limited to some days gets a window all day on those days (Mon is first)', wp && JSON.stringify(wp.want.days) === '[true,true,true,true,true,false,false]' && wp.want.start === '00:00' && wp.want.end === '23:59', JSON.stringify(wp));

  console.log('AS4 · check first: what would change');
  const have = { cards: [
    { card: 786777, controller: 423141044, have: { from: '2026-04-07', to: '2026-10-30', doors: [2, 0, 0, 0], pin: 1234 } },
    { card: 786777, controller: 423150481, have: null },
    { card: 800001, controller: 423141044, have: { from: '2020-01-01', to: '2099-12-31', doors: [1, 1, 0, 0], pin: 0 } },
    { card: 800001, controller: 423150481, have: { from: '2020-01-01', to: '2099-12-31', doors: [1, 1, 1, 1], pin: 0 } },
    { card: 700001, controller: 423141044, have: { from: '2026-04-07', to: '2026-10-30', doors: [2, 0, 0, 0], pin: 0 } },
    { card: 700001, controller: 423150481, have: null },
    { card: 700002, controller: 423141044, have: null },
    { card: 700002, controller: 423150481, have: null },
  ], profiles: [
    { controller: 423141044, id: 2, have: { from: '2025-04-07', to: '2026-10-31', days: [true, true, true, true, true, true, true], start: '06:00', end: '20:30' } },
    { controller: 423150481, id: 2, have: { from: '2027-05-23', to: '2027-10-31', days: [true, true, true, true, true, true, true], start: '06:00', end: '20:30' } },
  ] };
  const d = K.diffSync(K.syncPlan({ fobs: FOBS, config: CONFIG, doorsRaw: DOORS }), have);
  check('a card with new dates is changed, keeping its keypad PIN', d.ops.some(o => o.op === 'put' && o.card === 786777 && o.controller === 423141044 && o.pin === 1234 && o.from === '2027-05-23'), JSON.stringify(d.ops.filter(o => o.card === 786777)));
  check('a card missing from a controller is added', d.ops.some(o => o.op === 'put' && o.card === 786777 && o.controller === 423150481 && o.pin === 0));
  check('a card that already matches is left alone', !d.ops.some(o => o.card === 800001));
  check('a turned-off fob still on a controller is removed; one already gone isn\'t touched', d.ops.some(o => o.op === 'delete' && o.card === 700001 && o.controller === 423141044) && !d.ops.some(o => o.card === 700002));
  check('the Member window is updated only where it differs', d.ops.filter(o => o.op === 'profile').map(o => o.controller).join() === '423141044');
  check('the summary counts fobs to add, change and turn off, and windows', d.summary.add === 1 && d.summary.change === 1 && d.summary.remove === 1 && d.summary.profiles === 1 && d.summary.unchanged === 2, JSON.stringify(d.summary));
  check('each change reads plainly', d.lines.some(l => /Garcia/.test(l) && /786777/.test(l)) && d.lines.some(l => /Member hours/.test(l)), JSON.stringify(d.lines));
  check('nothing to do when the doors match', K.diffSync({ controllers: [], cards: [], profiles: [] }, { cards: [], profiles: [] }).ops.length === 0);
}

console.log('AS4 · the wiring');
const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /keyfob_sync/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
check('sync jobs are kept (check or send, their plan and result), privately', /create table if not exists public\.keyfob_syncs/i.test(mig) && /check \(kind in \('check', 'send'\)\)/i.test(mig) && /keyfob_syncs enable row level security/i.test(mig));
check('the "Auto keyfob activations" switch is per club and off by default', /tenants[\s\S]*auto_keyfob_sync boolean not null default false/i.test(mig));
const kf = read('supabase/functions/keyfobs/index.ts');
check('the Keyfobs & Access tab can check, send, and see where a sync is', /action === 'sync_check'/.test(kf) && /action === 'sync_send'/.test(kf) && /action === 'sync_status'/.test(kf) && /loadSyncPlan\(|syncPlan\(/.test(kf));
const send = between(kf, '// sync_send:', "if (action === 'set_level')");
check('a send only follows a finished check, and only its changes', /check_id/.test(send) && /chk\.status !== 'done'/.test(send) && /result[\s\S]*ops/.test(send));
check('syncing needs the gate computer\'s 1.4 update', /syncReady\(/.test(kf));
const gb = read('supabase/functions/gate_bridge/index.ts');
check('the gate computer is handed a sync only when no door is waiting (and only 1.4)', /keyfob_syncs/.test(gb) && /if \(!command && syncReady\(heartbeatVersion\)\)/.test(gb));
check('it reports back, and a check\'s changes are worked out from what it read', /action === 'sync_done'/.test(gb) && /diffSync\(/.test(gb));
check('an automatic check (the switch on) sends its changes by itself', /auto/.test(between(gb, "action === 'sync_done'", "action === 'heartbeat'")));
const pp = read('supabase/functions/payment_plans/index.ts');
check('the nightly run starts a sync only for clubs with the switch on', /auto_keyfob_sync/.test(pp) && /keyfob_syncs/.test(pp));
const ta = read('supabase/functions/tenants_admin/index.ts'), ad = read('admin/index.html');
check('only the provider can turn the switch on (Overrides)', /auto_keyfob_sync/.test(ta) && /Auto keyfob activations/.test(ad));
const py = read('bridge/gate_bridge.py');
check('bridge 1.4 reads and writes cards and time windows', /BRIDGE_VERSION\s*=\s*"1\.([4-9]|\d{2,})/.test(py) && /put_card\(/.test(py) && /delete_card\(/.test(py) && /get_card\(/.test(py) && /set_time_profile\(/.test(py) && /get_time_profile\(/.test(py));
const page = read('club/admin/keyfobs.html');
check('Keyfobs & Access has "Sync keyfobs now", shows what would change, and "Send to the doors"', /Sync keyfobs now/.test(page) && /Send to the doors/.test(page) && /sync_check/.test(page) && /sync_send/.test(page));

// PLAN.md AW (10/18): the first real sync job was never handed out. The
// database only takes "update the oldest one" (order + limit) when the sort
// column is also returned, and the claim didn't return created_at. The
// waiting job then cut every check-in short (a call every 5 s, not 2 min).
console.log('AW · handing a sync job to the gate computer');
{
  const { readdirSync: rd } = await import('node:fs');
  const bad = [];
  const walk = dir => { for (const f of rd(new URL(dir, root), { withFileTypes: true })) {
    if (f.isDirectory()) walk(`${dir}${f.name}/`);
    else if (f.name.endsWith('.ts')) {
      const src = read(`${dir}${f.name}`);
      for (const m of src.matchAll(/\.update\([^;]*?\.order\('([a-z_]+)'[^;]*?\.limit\(\d+\)[^;]*?\.select\('([^']*)'\)/g)) {
        if (!m[2].split(',').map(x => x.trim()).includes(m[1])) bad.push(`${dir}${f.name}: orders by ${m[1]}, returns ${m[2]}`);
      }
    }
  } };
  walk('supabase/functions/');
  check('every "update the oldest" returns the column it sorts by', bad.length === 0, bad.join(' | '));
  const claimPart = between(gb, '// Doors first: a keyfob sync is handed out', 'return jsonResponse(');
  check('a sync job that can\'t be handed out fails at once, so it can\'t cut check-ins short',
    /error: claimErr/.test(claimPart) && /if \(claimErr\)[\s\S]{0,300}status: 'failed'/.test(claimPart));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

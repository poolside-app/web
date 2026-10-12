#!/usr/bin/env node
// Targeted check for the gate bridge's check-ins (PLAN.md AA). Offline:
// reads the cloud side and runs the bridge loop against a fake cloud
// (scripts/test_gate_bridge_loop.py). Costs nothing.
//
// Usage: node scripts/test_gate_poll.mjs
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('AA1 · the cloud holds a check-in open (offline)');
let bp = null;
try { bp = await importTs(new URL('supabase/functions/_shared/bridge_poll.ts', root)); } catch (e) { check('the rules live in _shared/bridge_poll.ts', false, e.message); }
if (bp) {
  check('no wait asked for: answer at once (an old bridge works as before)', bp.pollWait(undefined) === 0 && bp.pollWait('x') === 0 && bp.pollWait(-5) === 0);
  check('AO1: a check-in can be held 2 minutes, never more (the free plan ends calls at 150 s)', bp.pollWait(120) === 120 && bp.pollWait(300) === 120 && bp.pollWait(20) === 20 && bp.MAX_WAIT_SEC === 120);
  check('AO1: while holding, it looks once a second (inside the 2 s CPU limit per call)', bp.LOOK_EVERY_MS === 1000);
  check('AO1: and stamps "last seen" at least every 30 seconds', bp.STAMP_EVERY_MS > 0 && bp.STAMP_EVERY_MS <= 30000);
}
const gb = read('supabase/functions/gate_bridge/index.ts');
const poll = gb.slice(gb.indexOf("action === 'poll'"), gb.indexOf("action === 'complete'"));
check('a check-in waits for an unlock, looking every second', /pollWait\(body\.wait\)/.test(poll) && /setTimeout\([^,]+,\s*LOOK_EVERY_MS\)/.test(poll));
check('AO1: a long hold keeps "last seen" fresh', /STAMP_EVERY_MS/.test(poll) && /bridge_last_seen_at/.test(poll.slice(poll.indexOf('while ('))));
check('AO2: the answer tells the bridge how long to wait next time', /next_wait:\s*MAX_WAIT_SEC/.test(poll));
check('it stops waiting if the bridge hung up, so no unlock is lost', /req\.signal\.aborted/.test(poll));

console.log('AA2 · the bridge (offline, fake cloud)');
const py = spawnSync('python3', [new URL('scripts/test_gate_bridge_loop.py', root).pathname], { encoding: 'utf8' });
for (const line of (py.stdout || '').split('\n').filter(l => /^\s+[✓✗]/.test(l))) {
  check(line.trim().slice(2), line.includes('✓'));
}
if (py.status !== 0 && !/[✓✗]/.test(py.stdout || '')) check('the bridge loop test runs', false, (py.stderr || '').slice(-300));
const bridge = read('bridge/gate_bridge.py');
check("the bridge is version 1.3 or later", /BRIDGE_VERSION\s*=\s*"1\.([3-9]|\d{2,})/.test(bridge));
check('each call\'s time limit outlasts its own wait', /timeout=wait \+ 15/.test(bridge));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

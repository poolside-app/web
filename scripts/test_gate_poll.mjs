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
  check('wait is capped at 20 seconds', bp.pollWait(20) === 20 && bp.pollWait(300) === 20 && bp.pollWait(7) === 7);
}
const gb = read('supabase/functions/gate_bridge/index.ts');
const poll = gb.slice(gb.indexOf("action === 'poll'"), gb.indexOf("action === 'complete'"));
check('a check-in waits for an unlock, looking every half second', /pollWait\(body\.wait\)/.test(poll) && /setTimeout\([^,]+,\s*500\)/.test(poll));
check('it stops waiting if the bridge hung up, so no unlock is lost', /req\.signal\.aborted/.test(poll));

console.log('AA2 · the bridge (offline, fake cloud)');
const py = spawnSync('python3', [new URL('scripts/test_gate_bridge_loop.py', root).pathname], { encoding: 'utf8' });
for (const line of (py.stdout || '').split('\n').filter(l => /^\s+[✓✗]/.test(l))) {
  check(line.trim().slice(2), line.includes('✓'));
}
if (py.status !== 0 && !/[✓✗]/.test(py.stdout || '')) check('the bridge loop test runs', false, (py.stderr || '').slice(-300));
const bridge = read('bridge/gate_bridge.py');
check('the bridge is version 1.1', /BRIDGE_VERSION\s*=\s*"1\.1/.test(bridge));
check('its HTTP timeout outlasts the wait', /timeout=WAIT_SEC \+ 15/.test(bridge));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

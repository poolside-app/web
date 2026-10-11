#!/usr/bin/env node
// Targeted check for the Drive backup queue (PLAN.md Z). Offline: reads the
// code. Costs nothing.
//
// Usage: node scripts/test_drive_queue.mjs
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const between = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, s.indexOf(b, i + a.length)); };

console.log('Z1 · backups for deleted signups (offline)');
const gd = read('supabase/functions/google_drive_sync/index.ts');
const retry = between(gd, "action === 'retry_queue'", "return jsonResponse({ ok: true, attempted");
check('a retry drops a backup whose signup was deleted, instead of retrying it forever',
  /application not found/.test(retry) && /drive_sync_queue'\)\.delete\(\)/.test(retry), retry.slice(0, 120));
check('"Retry failed syncs" tries every waiting backup now, not only ones past their wait', !/lte\('next_retry_at'/.test(retry));
const hh = read('supabase/functions/households_admin/index.ts');
const purge = between(hh, "action === 'purge_household'", "action === 'add_member'");
check('deleting a family for good also removes its waiting backups', /from\('drive_sync_queue'\)\.delete\(\)/.test(purge) && purge.indexOf("drive_sync_queue") < purge.indexOf("from('applications').delete()"));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

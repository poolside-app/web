#!/usr/bin/env node
// Targeted check that deleting an announcement deletes it (PLAN.md AN).
// Offline: reads posts_admin and the Announcements page. Costs nothing.
//
// Usage: node scripts/test_posts_delete.mjs
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };

console.log('AN1 · Delete post deletes it');
const fn = read('supabase/functions/posts_admin/index.ts');
const del = between(fn, "action === 'delete'", 'Unknown action');
check('posts_admin delete removes the row', /from\('posts'\)\s*\.delete\(\)/.test(del), del.slice(0, 200));
check('it no longer just hides it', !/active:\s*false/.test(del));
check('only this club\'s post', /\.eq\('tenant_id', TID\)/.test(del));
check('the title goes in the audit log', /audit_log/.test(del) && /title/.test(del));

const page = read('club/admin/announcements.html');
check('the button says Delete post', /id="m-delete"[^>]*>Delete post</.test(page));
const d = between(page, 'async function del(', '\n}\n');
const dp = between(page, 'async function delPost(', '\n}\n');
check('one confirm that says it is for good', /confirm\([^)]*for good/.test(dp) && /delPost\(id\)/.test(d), dp.slice(0, 160));

console.log('AN2 · posts removed before this can be deleted');
check('the edit pop-up offers Delete for every post', /m-delete'\)\.style\.display = 'inline-block'/.test(page) && !/m-delete'\)\.style\.display = p\.active/.test(page));
const card = between(page, 'function render(posts)', '\n}\n');
check('a removed post has a Delete button on its card', /p\.active \?[\s\S]*delPost\(/.test(card));
check('that button deletes it after the same confirm, and shows any error', /delPost\('\$\{p\.id\}'\)\.catch\(/.test(card) && /call\('delete', \{ id \}\)/.test(dp));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

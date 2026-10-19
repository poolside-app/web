#!/usr/bin/env node
// Targeted check for Insights → Time saved (PLAN.md BB, Doug 10/19: "i want
// to show how much time is saved by using this app"). Offline: the rules in
// _shared/time_saved.ts and the page's wiring. Costs nothing.
//
// Usage: node scripts/test_time_saved.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BB · the time saved');
let ts = null;
try { ts = await importTs(new URL('supabase/functions/_shared/time_saved.ts', root)); } catch (e) { check('the rules live in _shared/time_saved.ts', false, e.message); }
if (ts) {
  const d = ts.cleanTimeSaved({});
  check('Doug\'s numbers: $20 an hour, and the minutes each thing used to take',
    d.per_hour === 20 && d.minutes.signup === 10 && d.minutes.payment === 5 && d.minutes.keyfob === 10 && d.minutes.plan_payment === 5
      && d.minutes.party === 20 && d.minutes.door === 15 && d.minutes.signup_form === 60, JSON.stringify(d));
  check('every row says what used to be done by hand', ts.ITEMS.every(i => i.key in d.minutes && i.label && i.before));
  const r = ts.computeTimeSaved({ signup: 30, payment: 40, keyfob: 12, plan_payment: 10, party: 6, door: 20, signup_form: 1 }, d);
  // 300 + 200 + 120 + 50 + 120 + 300 + 60 = 1150 minutes
  check('minutes add up, hours and dollars follow', r.minutes === 1150 && Math.abs(r.hours - 1150 / 60) < 1e-9 && r.dollars === Math.round(1150 / 60 * 20), JSON.stringify({ m: r.minutes, h: r.hours, d: r.dollars }));
  check('each row shows its count, minutes each and total', r.rows.find(x => x.key === 'door').count === 20 && r.rows.find(x => x.key === 'door').total_minutes === 300);
  const c = ts.cleanTimeSaved({ per_hour: 900, minutes: { signup: -5, party: 'abc', door: 30.6 } });
  check('edits are kept sensible: 0 to 600 minutes, $0 to $200 an hour, whole numbers', c.per_hour === 200 && c.minutes.signup === 0 && c.minutes.party === 20 && c.minutes.door === 31, JSON.stringify(c));
  check('nothing counted yet is zero, not an error', ts.computeTimeSaved({}, d).minutes === 0);
}
const src = ts ? read('supabase/functions/_shared/time_saved.ts') : '';
check('fobs brought over from the old program don\'t count', /neq\('reason', 'imported'\)/.test(src));
check('test unlocks don\'t count', /\.eq\('is_test', false\)/.test(src) || /is_test\.is\.null/.test(src));
const fn = read('supabase/functions/admin_tasks/index.ts');
check('the board gets it from admin_tasks, and only Settings can change it',
  /action === 'time_saved'/.test(fn) && /action === 'time_saved_save'/.test(fn) && /caller\.isOwner \|\| caller\.scopes\.includes\('settings'\)/.test(fn));
const nav = read('js/admin-subtabs.js');
check('Insights → Time saved, for every board member', /\{ key: 'timesaved', label: 'Time saved', href: '\/club\/admin\/time-saved\.html', scope: '' \}/.test(nav) && /'time-saved\.html': 'insights'/.test(nav));
const page = read('club/admin/time-saved.html');
check('the page says it plainly: if the club paid someone', /If the club paid someone/.test(page) && /since your club started on Poolside/i.test(page) && /callAt\(TASKS_URL, 'time_saved'/.test(page));
check('a help article covers it', /Insights → Time saved/.test(read('club/admin/help/articles/time-saved.md')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

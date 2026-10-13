#!/usr/bin/env node
// Targeted check that the board's lists stay short with 100+ families
// (PLAN.md AP). Offline: runs js/list-fold.js and reads the two pages.
// Costs nothing.
//
// Usage: node scripts/test_long_lists.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };

let F = null;
try {
  const sandbox = { window: {} };
  vm.runInNewContext(read('js/list-fold.js'), sandbox);
  F = sandbox.window.PoolsideFold;
} catch (e) { check('the folding rules live in js/list-fold.js', false, e.message); }

console.log('AP1 · Needs you groups repeats');
if (F) {
  const t = (kind, i) => ({ id: `${kind}-${i}`, kind, created_at: new Date(Date.now() - i * 3600e3).toISOString() });
  const tasks = [t('payments.approve_due', 0), ...[0, 1, 2, 3, 4].map(i => t('application.submitted', i)),
    t('help.request', 0), t('help.request', 1), ...Array.from({ length: 12 }, (_, i) => t('keyfob.issue', i)), t('keyfob.off', 0)];
  const items = F.groupTodos(tasks);
  const shape = items.map(x => x.group ? `${x.key}×${x.tasks.length}` : x.task.kind).join(', ');
  check('3+ of a kind become one row; fewer stay as they are', shape === 'payments.approve_due, application.submitted×5, help.request, help.request, keyfob.issue×12, keyfob.off', shape);
  check('a group keeps every to-do inside it (nothing dropped)', items.reduce((n, x) => n + (x.group ? x.tasks.length : 1), 0) === tasks.length);
  check('a group is where its first to-do was', items[1].group && items[1].tasks[0].id === 'application.submitted-0');
  check('labels read plainly', F.todoLabel('keyfob.issue', 12) === '12 keyfobs to issue' && F.todoLabel('application.submitted', 5) === '5 signups to review'
    && F.todoLabel('venmo.claim', 4) === '4 Venmo payments to check' && F.todoLabel('help.request', 3) === '3 member questions', F.todoLabel('keyfob.issue', 12));
  check('a kind without its own label still reads', /3/.test(F.todoLabel('household.something', 3, 'Family change')) && /Family change/.test(F.todoLabel('household.something', 3, 'Family change')));
  check('Venmo claims of any kind group together', F.groupTodos([t('venmo.claim', 0), t('party.venmo_claim', 1), t('keyfob.venmo', 2)]).length === 1);
}
const home = read('club/admin/index.html');
check('the dashboard loads the folding rules', /<script src="\/js\/list-fold\.js"><\/script>/.test(home));
const needs = between(home, '── Needs you', '── Today at the pool');
check('Needs you draws groups', /PoolsideFold\.groupTodos\(/.test(needs) && /class="todo-group"/.test(needs) && /PoolsideFold\.todoLabel\(/.test(needs));
check('a group has one Open button to its page and opens to show each to-do', /<summary[\s\S]*hbtn[\s\S]*<\/summary>/.test(needs) && /todoRow\)\.join/.test(needs));
check('6 rows show before "Show N more", counting a group as one', /items\.slice\(0, SHOW\)/.test(needs) && /items\.length > SHOW/.test(needs));

console.log('AP2/AP3 · the Keyfobs page');
if (F) {
  const hh = Array.from({ length: 171 }, (_, i) => ({ id: `h${i}`, family_name: i === 7 ? 'Garcia' : `Family ${String(i).padStart(3, '0')}`, address: `${1800 + i} Polk St` }));
  const fobs = [];
  hh.forEach((h, i) => { fobs.push({ id: `f${i}`, household_id: h.id, family_name: h.family_name, status: 'active', card_number: 700000 + i }); });
  for (let i = 0; i < 34; i++) fobs.push({ id: `g${i}`, household_id: `h${i}`, family_name: hh[i].family_name, status: i === 3 ? 'off' : 'active', card_number: 800000 + i });
  fobs.push({ id: 'r1', household_id: 'h5', family_name: hh[5].family_name, status: 'requested' }, { id: 'l1', household_id: 'h6', family_name: hh[6].family_name, status: 'lost', card_number: 900000 });
  fobs.push({ id: 'p1', household_id: 'h7', family_name: 'Garcia', status: 'active', card_number: 12 * 65536 + 345 });
  const rows = F.familyRows(fobs, hh);
  check('one row per family with fobs (171), each with its fobs', rows.length === 171 && rows.find(r => r.household_id === 'h0').fobs.length === 2, String(rows.length));
  check('requested and lost fobs aren\'t in the lookup (they\'re in the work above)', !rows.some(r => r.fobs.some(f => f.status === 'requested' || f.status === 'lost')));
  check('turned-off fobs stay in the lookup', rows.find(r => r.household_id === 'h3').fobs.some(f => f.status === 'off'));
  check('rows are in family-name order', rows[0].family_name <= rows[1].family_name && rows[1].family_name <= rows[2].family_name);
  check('search by family name', F.findFamilies(rows, 'garc').map(r => r.family_name).join() === 'Garcia');
  check('search by address', F.findFamilies(rows, '1807 polk').map(r => r.family_name).join() === 'Garcia');
  check('search by fob number', F.findFamilies(rows, '800020').length === 1 && F.findFamilies(rows, '800020')[0].household_id === 'h20');
  check('search by the printed facility,card form', F.findFamilies(rows, '012,00345').map(r => r.family_name).join() === 'Garcia');
  check('no search: nothing listed until asked', F.findFamilies(rows, '').length === 171 && F.firstN(rows, 0).length === 0);
  check('25 at a time', F.firstN(rows, 25).length === 25 && F.firstN(rows, 50).length === 50 && F.firstN(rows.slice(0, 10), 25).length === 10);
  const q = F.workQueue([{ id: 'a', requested_at: '2026-10-03' }, { id: 'b', requested_at: '2026-10-01' }, { id: 'c', requested_at: '2026-10-02' }]);
  check('the work is oldest first', q.map(x => x.id).join() === 'b,c,a', q.map(x => x.id).join());
}
const kf = read('club/admin/keyfobs.html');
check('the Keyfobs page loads the folding rules', /<script src="\/js\/list-fold\.js"><\/script>/.test(kf));
const paint = between(kf, 'function paint()', '\nfunction paintAll');
const fold = between(kf, 'function moreFold', '\n}\n');
check('fobs to issue: oldest first, 10 shown, then "Show N more"', /PoolsideFold\.workQueue\(/.test(paint) && /WORK_SHOW\s*=\s*10/.test(kf)
  && /slice\(0, WORK_SHOW\)/.test(fold) && /Show \$\{[^}]+\} more/.test(fold) && /moreFold\(ready, issueRow\)/.test(paint));
check('waiting on payment folds into one line', /<details[^>]*id="wait-wrap"/.test(kf) && /waiting on payment/.test(kf));
const all = between(kf, 'function paintAll', '\nasync function issue');
check('all fobs: a lookup by family, address or number', /PoolsideFold\.familyRows\(/.test(all) && /PoolsideFold\.findFamilies\(/.test(all) && /placeholder="Search family, address or fob number"/.test(kf));
check('without a search only the count and "Show all families"', /Show all \$\{/.test(all) && /families/.test(all) && /PoolsideFold\.firstN\(/.test(all));
check('25 at a time, then "Show 25 more"', /PAGE\s*=\s*25/.test(kf) && /Show \$\{Math\.min\(PAGE/.test(all));
check('"Add a fob a family already has" folds into one line', /<details[^>]*id="add-wrap"/.test(kf));
check('the buttons on each fob still work (Broken, Turn off)', /swapFob\(/.test(all) && /turnedOff\(/.test(all));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

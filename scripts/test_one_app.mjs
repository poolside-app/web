#!/usr/bin/env node
// Targeted check for one Home Screen app for board members who are also
// members (PLAN.md AH). Offline: reads the pages, the pop-up worker and the
// two pop-up functions. Costs nothing.
//
// Usage: node scripts/test_one_app.mjs
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('AH1 · board first (offline)');
const home = read('m/index.html');
const start = home.slice(home.indexOf("const handoff = new URLSearchParams(location.search).get('h');"), home.indexOf("if (!token()) { logout(); return; }"));
check('the member app opens the board when it has a board sign-in, after the Home Screen sign-in is kept', /boardFirst\(\)/.test(start) && start.indexOf('boardFirst()') > start.indexOf("action: 'verify'"));
check('"Member view" keeps them on the member side for the visit', /view'\) === 'member'/.test(home) && /sessionStorage\.setItem\('poolside_view', 'member'\)/.test(home) && /location\.replace\('\/club\/admin\/'\)/.test(home));
check('"Board tools" switches back', /board-switch[\s\S]{0,400}sessionStorage\.removeItem\('poolside_view'\)/.test(home) || /getElementById\('board-switch'\)[\s\S]{0,300}removeItem\('poolside_view'\)/.test(home));
const login = read('m/login.html');
check('the member sign-in page follows the same rule', /poolside_view/.test(login) && /location\.replace\('\/club\/admin\/'\)/.test(login) && /Go to the board/.test(login));
const board = read('club/admin/index.html');
check('"Member view" on the board home says so', /id="member-switch" href="\/m\/\?view=member"/.test(board) && /'\/m\/\?view=member'/.test(read('js/admin-subtabs.js')));
const flags = read('js/admin-flags.js');
const lo = flags.slice(flags.indexOf('function poolsideLogout'), flags.indexOf('function poolsideLogout') + 900);
check('removed from the board: the app drops the board sign-in and opens the member side', /poolside_member_token/.test(lo) && /location\.replace\('\/m\/'\)/.test(lo));

console.log('AH2 · both kinds of pop-ups (offline)');
const pa = read('supabase/functions/push_admin/index.ts');
const pm = read('supabase/functions/push_member/index.ts');
check('board pop-ups on: member pop-ups too, for their family', /membersForAdmin\(/.test(pa.slice(pa.indexOf("action === 'subscribe'"))) && /member_push_subscriptions/.test(pa));
check('member pop-ups on: board pop-ups too, for their board login', /adminsForMember\(/.test(pm.slice(pm.indexOf("action === 'subscribe'"))) && /admin_push_subscriptions/.test(pm));
check('the match is the same three ways as "Board tools" (linked, phone, email)', /linked_member_id/.test(read('supabase/functions/_shared/board_member.ts')) && /phone_e164/.test(read('supabase/functions/_shared/board_member.ts')));
const ap = read('js/admin-push.js');
const unsub = ap.slice(ap.indexOf('async function unsubscribe'), ap.indexOf('async function unsubscribe') + 700);
check('turning off board pop-ups leaves member pop-ups on', !/sub\.unsubscribe\(\)/.test(unsub));

console.log('AH3 · each pop-up opens its side (offline)');
const sw = read('sw.js');
check('a member pop-up opens the member side', /view=member/.test(sw.slice(sw.indexOf('notificationclick'))));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

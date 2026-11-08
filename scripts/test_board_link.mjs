#!/usr/bin/env node
// A member invited to the board is linked to their own family, by their
// mobile number (PLAN.md CN). Doug 11/8: "if they are already a member, it
// will link the accounts and both options for board or member view can flip
// back and forth", and "If it's a family Membership, the family shouldn't
// have board access.. So track that by the phone number".
//
// Offline: the linking against a pretend database, and the wiring. Costs
// nothing.
//
// Usage: node scripts/test_board_link.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeDb } from './lib/fake_google.mjs';

globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 240);

const bm = await importTs(new URL('supabase/functions/_shared/board_member.ts', root));
const world = () => ({
  households: [
    { id: 'h1', tenant_id: 't', family_name: 'Skeen Family', active: true },
    { id: 'h2', tenant_id: 'other', family_name: 'Elsewhere', active: true },
  ],
  household_members: [
    { id: 'm1', tenant_id: 't', household_id: 'h1', role: 'primary', active: true, phone_e164: '+14085550001', email: 'fam@x.com' },
    { id: 'm2', tenant_id: 't', household_id: 'h1', role: 'adult', active: true, phone_e164: '+14085550002', email: 'fam@x.com' },
    { id: 'm3', tenant_id: 't', household_id: 'h1', role: 'child', active: true, phone_e164: null, email: null },
    { id: 'm9', tenant_id: 'other', household_id: 'h2', role: 'primary', active: true, phone_e164: '+14085550009', email: 'else@x.com' },
  ],
  admin_users: [],
  audit_log: [],
});

console.log('CN1, CN2 · a board login finds its person by mobile number');
{
  const T = world();
  T.admin_users.push({ id: 'a1', tenant_id: 't', active: true, phone_e164: '+14085550002', email: 'mike@x.com', linked_member_id: null });
  const sb = fakeDb(T);
  const r = await bm.linkAdminByPhone(sb, 't', T.admin_users[0]);
  check('linked to the person with that number, the spouse, not the family\'s primary', T.admin_users[0].linked_member_id === 'm2' && r?.family_name === 'Skeen Family', short({ r, a: T.admin_users[0] }));
  check('logged', T.audit_log.some(a => a.kind === 'admin.linked_to_member' && a.entity_id === 'a1'));
  const again = await bm.linkAdminByPhone(sb, 't', T.admin_users[0]);
  check('already linked: left alone', T.admin_users[0].linked_member_id === 'm2' && again?.member_id === 'm2', short(again));
}
{
  const T = world();
  T.admin_users.push({ id: 'a2', tenant_id: 't', active: true, phone_e164: null, email: 'fam@x.com', linked_member_id: null });
  await bm.linkAdminByPhone(fakeDb(T), 't', T.admin_users[0]);
  check('the same email is not enough: an email-only board login links nobody', T.admin_users[0].linked_member_id === null, short(T.admin_users[0]));
}
{
  const T = world();
  T.admin_users.push({ id: 'a3', tenant_id: 't', active: true, phone_e164: '+14085550009', linked_member_id: null });
  await bm.linkAdminByPhone(fakeDb(T), 't', T.admin_users[0]);
  check('a member of another club with that number is never linked', T.admin_users[0].linked_member_id === null);
}
{
  const T = world();
  T.household_members[1].active = false;
  T.admin_users.push({ id: 'a4', tenant_id: 't', active: true, phone_e164: '+14085550002', linked_member_id: null });
  await bm.linkAdminByPhone(fakeDb(T), 't', T.admin_users[0]);
  check('a removed family member is never linked', T.admin_users[0].linked_member_id === null);
}

console.log('CN3 · a family approved after the person is on the board');
{
  const T = world();
  T.admin_users.push(
    { id: 'b1', tenant_id: 't', active: true, phone_e164: '+14085550002', email: 'other@x.com', linked_member_id: null },
    { id: 'b2', tenant_id: 't', active: true, phone_e164: '+19995550000', email: 'fam@x.com', linked_member_id: null },
  );
  const n = await bm.linkHousehold(fakeDb(T), 't', 'h1');
  check('the board member is linked to themselves in the family, by number', T.admin_users[0].linked_member_id === 'm2' && n === 1, short(T.admin_users));
  check('a board login sharing only the family\'s email gets nothing', T.admin_users[1].linked_member_id === null);
}

console.log('CN4 · phone only everywhere');
{
  const src = read('supabase/functions/_shared/board_member.ts');
  check('the pop-up switch matches the link or the same mobile number, not email', !/email\.eq\./.test(src), (src.match(/.*email\.eq.*/g) || []).join(' | '));
  const ma = read('supabase/functions/member_auth/index.ts');
  const blk = between(ma, 'let is_board_member = false;', 'catch');
  check('the family side\'s Board tools: the link or the same mobile number, not email', /phone_e164\.eq/.test(blk) && !/email\.eq/.test(blk), blk.slice(0, 300));
  const ap = read('supabase/functions/applications/index.ts');
  check('approving a family links by number, any adult', /linkHousehold\(/.test(ap) && !/email\.ilike\.\$\{identity\.email\}/.test(ap));
}

console.log('CN1 · the invite, the board home, the Board page');
{
  const ta = read('supabase/functions/tenant_admin_auth/index.ts');
  const inv = between(ta, "action === 'invite_admin'", "action === 'update_admin_title'");
  check('the invite links a member with the same number and says which family', /linkAdminByPhone\(/.test(inv) && /member_family/.test(inv));
  const me = between(ta, "action === 'me'", 'getHouseholdCapStatus');
  check('anyone already on the board is linked when they open it', /linkAdminByPhone\(/.test(me) && /linked_member_id/.test(me));
  const board = read('club/admin/board.html');
  check('the Board page says they\'re a member too and can switch', /member_family/.test(board) && /a member too/.test(board) && /switch between the board and their family/.test(board));
  const home = read('club/admin/index.html'), nav = read('js/admin-subtabs.js');
  check('a linked board member gets Member view (board home, and More on phones)', /if \(memberSwitch && user\.linked_member_id\)/.test(home) && /memberView = navUser && navUser\.linked_member_id/.test(nav));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// A membership discount for each board member (PLAN.md CO). Doug 11/8: "when
// adding that board member, there should be a spot that has a check box
// allowing for a free membership? … Or have a discount apply right there?"
//
// Offline: the price with a board discount, who gets it (a board login linked
// to the family, or their own signup from the board home, never a typed phone
// number), and the wiring. Costs nothing.
//
// Usage: node scripts/test_board_discount.mjs
import { readFileSync, readdirSync } from 'node:fs';
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
const short = v => JSON.stringify(v)?.slice(0, 260);

console.log('CO2 · the price');
{
  const pr = await importTs(new URL('supabase/functions/_shared/pricing.ts', root));
  const free = pr.priceMembership({ baseCents: 60000, boardOffCents: 60000 });
  check('free: nothing to pay, "board" discount', free.amount_due_cents === 0 && free.discount_kind === 'board' && free.discount_cents === 60000, short(free));
  const half = pr.priceMembership({ baseCents: 60000, boardOffCents: 30000, code: { id: 'c1', code: 'SAVE20', percent_off: 20, amount_cents: null, active: true } });
  check('half off beats a 20% code: one discount counts, the bigger', half.discount_kind === 'board' && half.amount_due_cents === 30000, short(half));
  const code = pr.priceMembership({ baseCents: 60000, boardOffCents: 6000, code: { id: 'c1', code: 'BIG', percent_off: 50, amount_cents: null, active: true } });
  check('a bigger code still wins over a small board discount', code.discount_kind === 'code' && code.amount_due_cents === 30000, short(code));
}

console.log('CO2 · who gets it');
let bd = null;
try { bd = await importTs(new URL('supabase/functions/_shared/board_discount.ts', root)); }
catch (e) { check('_shared/board_discount.ts loads', false, String(e.message).slice(0, 160)); }
const world = () => ({
  tenants: [{ id: 't', timezone: 'America/Los_Angeles' }],
  admin_users: [
    { id: 'a1', tenant_id: 't', active: true, display_name: 'Mike Smith', member_discount_pct: 100, linked_member_id: 'm2', phone_e164: '+14085550002' },
    { id: 'a2', tenant_id: 't', active: true, display_name: 'Sue Lee', member_discount_pct: 50, linked_member_id: null, phone_e164: '+14085550005' },
    { id: 'a3', tenant_id: 't', active: false, display_name: 'Gone', member_discount_pct: 100, linked_member_id: 'm7', phone_e164: '+14085550007' },
    { id: 'a4', tenant_id: 'other', active: true, display_name: 'Elsewhere', member_discount_pct: 100, linked_member_id: null, phone_e164: null },
    { id: 'a5', tenant_id: 't', active: true, display_name: 'No discount', member_discount_pct: 0, linked_member_id: 'm8', phone_e164: '+14085550008' },
  ],
  household_members: [
    { id: 'm1', tenant_id: 't', household_id: 'h1', active: true, phone_e164: '+14085550001' },
    { id: 'm2', tenant_id: 't', household_id: 'h1', active: true, phone_e164: '+14085550002' },
    { id: 'm7', tenant_id: 't', household_id: 'h7', active: true, phone_e164: '+14085550007' },
    { id: 'm8', tenant_id: 't', household_id: 'h8', active: true, phone_e164: '+14085550008' },
  ],
});
if (bd) {
  const T = world(), sb = fakeDb(T);
  const r1 = await bd.boardDiscountFor(sb, 't', { householdId: 'h1' });
  check('renewing: a family with a board member linked to it gets their discount', r1?.pct === 100 && r1?.name === 'Mike Smith', short(r1));
  const r2 = await bd.boardDiscountFor(sb, 't', { boardAdminId: 'a2' });
  check('their own signup from the board home gets it', r2?.pct === 50, short(r2));
  check('someone off the board: none', (await bd.boardDiscountFor(sb, 't', { householdId: 'h7' })) === null);
  check('another club\'s board: none', (await bd.boardDiscountFor(sb, 't', { boardAdminId: 'a4' })) === null);
  check('a board member with no discount: none', (await bd.boardDiscountFor(sb, 't', { householdId: 'h8' })) === null);
  check('nothing to go on: none (a typed phone number never counts)', (await bd.boardDiscountFor(sb, 't', {})) === null);
  check('the input has no phone: only the link or their board sign-in', !/phone/.test(between(read('supabase/functions/_shared/board_discount.ts'), 'export async function boardDiscountFor', '\n}\n')));
}
{
  const mp = await importTs(new URL('supabase/functions/_shared/membership_price.ts', root));
  const T = world();
  T.settings = [{ tenant_id: 't', value: { membership_tiers: [{ slug: 'family', label: 'Family', price_cents: 60000 }] } }];
  T.households = [{ id: 'h1', tenant_id: 't', referral_credits_cents: 0 }];
  const sv = T.settings[0].value;
  let p = null;
  try { p = await mp.priceFor(fakeDb(T), 't', sv, { tierSlug: 'family', householdId: 'h1', isRenewal: true }); }
  catch (e) { check('priceFor runs with a board discount', false, String(e.message).slice(0, 160)); }
  check('Mike\'s family renews for free, and the page can say why', p?.amount_due_cents === 0 && p?.discount_kind === 'board' && p?.board_name === 'Mike Smith' && p?.board_pct === 100, short(p));
  const typed = await mp.priceFor(fakeDb(T), 't', sv, { tierSlug: 'family', phone: '+14085550002', email: null });
  check('a new signup that only types Mike\'s number pays full price', typed.amount_due_cents === 60000 && typed.discount_kind !== 'board', short(typed));
  const own = await mp.priceFor(fakeDb(T), 't', sv, { tierSlug: 'family', boardAdminId: 'a2' });
  check('Sue signing up from her board home: half off', own.amount_due_cents === 30000 && own.discount_kind === 'board', short(own));
  const ma = read('supabase/functions/_shared/membership_price.ts');
  check('an application keeps who started it from the board', /board_admin_id/.test(ma) && /boardAdminId: app\.board_admin_id/.test(ma));
}

console.log('CO1 · the Board page');
{
  const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /board_discount/.test(f));
  const sql = mig.length ? read(`supabase/migrations/${mig[0]}`) : '';
  check('a migration: the discount on the board login, who started an application, and the "board" kind', /add column if not exists member_discount_pct/i.test(sql) && /add column if not exists board_admin_id/i.test(sql) && /'board'/.test(sql), mig.join(','));
  const ta = read('supabase/functions/tenant_admin_auth/index.ts');
  check('inviting someone saves their discount', /member_discount_pct/.test(between(ta, "action === 'invite_admin'", "action === 'update_admin_title'")));
  const bf = read('supabase/functions/board/index.ts');
  const set = between(bf, "action === 'set_member_discount'", "if (action === '");
  check('the board list carries each person\'s discount', /member_discount_pct/.test(between(bf, "action === 'get'", "action === 'mine'")));
  check('changing it: the President (or full access) only, 0 to 100', /onlyPresident\(\)/.test(set) && /member_discount_pct/.test(set) && /100/.test(set));
  const bp = read('club/admin/board.html');
  check('the invite has Membership discount: None, Half off, Free, another percent', /id="iv-discount"/.test(bp) && /Half off/.test(bp) && /Free/.test(bp) && /member_discount_pct/.test(bp));
  check('each board member\'s row shows it and the President can change it', /Free membership/.test(bp) && /set_member_discount/.test(bp));
}

console.log('CO2, CO3 · the signup and renewal pages');
{
  const ap = read('supabase/functions/applications/index.ts');
  const q = between(ap, "action === 'quote'", 'quotePlan(');
  check('the join form\'s price asks with their board sign-in', /board_token/.test(q) && /boardAdminId/.test(q));
  const sub = between(ap, "if (action === 'submit')", "action === 'post_payment_signin'");
  check('the signup keeps who started it from the board', /board_token/.test(sub) && /board_admin_id/.test(sub));
  check('the price sent to the page names the board discount', /board_name/.test(between(ap, 'function publicPrice', '\n}\n')));
  const page = read('apply.html');
  check('"Sign up your own family" sends their board sign-in with the price and the signup', (page.match(/board_token: BOARD_TOKEN/g) || []).length >= 2);
  check('the join form says "Board member discount"', /discount_kind === 'board'/.test(page) && /Board member discount/.test(page));
  check('both renewal pages say it too', ['renew.html', 'm/renew.html'].every(f => /Board member discount/.test(read(f))));
  check('the board\'s Signups say it ("after a $600 board member discount")', /discount_kind === 'board' \? 'board member'/.test(read('club/admin/members.html')));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

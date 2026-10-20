#!/usr/bin/env node
// Targeted check for Venmo codes and batch approval (PLAN.md BC1, Doug
// 10/19: "create the auto load family name, amount, and code... then put
// that code into the poolside app as well.. batch approval would be great").
// Offline: the note and link builders and the wiring. Costs nothing.
//
// Usage: node scripts/test_venmo_codes.mjs
import { readFileSync, readdirSync } from 'node:fs';
import vm from 'node:vm';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BC1 · the note and the link');
let v = null, cv = null;
try { v = await importTs(new URL('supabase/functions/_shared/venmo.ts', root)); } catch (e) { check('the server builder lives in _shared/venmo.ts', false, e.message); }
try { const box = { window: {} }; vm.runInNewContext(read('js/venmo.js'), box); cv = box.window.PoolsideVenmo; } catch (e) { check('the page builder lives in js/venmo.js', false, e.message); }
if (v && cv) {
  const args = { club: 'Cabana Club', what: '2027 dues', family: 'Frevele Family', code: 'K7Q2' };
  check('the note: club, what, family, code', v.venmoNote(args) === 'Cabana Club 2027 dues - Frevele - #K7Q2', v.venmoNote(args));
  check('the app and the server write the same note', cv.note(args) === v.venmoNote(args), cv.note(args));
  const link = v.venmoLink({ handle: '@bishopestates', amountCents: 60000, note: v.venmoNote(args) });
  check('the link opens the club\'s Venmo with the amount and note', link === 'https://venmo.com/bishopestates?txn=pay&amount=600.00&note=Cabana%20Club%202027%20dues%20-%20Frevele%20-%20%23K7Q2', link);
  check('the app and the server build the same link', cv.link({ handle: '@bishopestates', amountCents: 60000, note: v.venmoNote(args) }) === link);
  check('no amount, no amount in the link', !/amount=/.test(v.venmoLink({ handle: 'x', amountCents: 0, note: 'n' })));
  check('"The Smith Family" reads as Smith', v.familyShort('The Smith Family') === 'Smith' && v.familyShort('Garcia') === 'Garcia');
}
const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /venmo_codes/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('');
check('a code on every signup, party and keyfob, from letters that can\'t be confused',
  /'23456789ABCDEFGHJKMNPQRSTUVWXYZ'/.test(mig) && ['applications', 'party_bookings', 'keyfobs'].every(t => new RegExp(`alter table public\\.${t} add column if not exists venmo_code text default public\\.venmo_code\\(\\)`).test(mig)));
check('the code function is private (service role only)', /revoke execute on function public\.venmo_code\(\) from public, anon, authenticated/.test(mig) && /grant execute on function public\.venmo_code\(\) to service_role/.test(mig));

console.log('BC1 · the family sees it');
const apps = read('supabase/functions/applications/index.ts');
check('signup: the answer carries the Venmo code, note and link', /venmo: venmoPay/.test(apps) && /venmo_code/.test(apps.match(/const FIELDS = '[^']*'/)[0]));
check('signup: the "received" email has the pay link and code', /venmo_link:/.test(apps) && /venmo_code:/.test(apps));
const em = read('supabase/functions/_shared/email_template.ts');
check('the email shows a Pay with Venmo button with the code', /v\.venmo_link/.test(em) && /v\.venmo_code/.test(em));
const ap = read('apply.html');
check('signup: after submitting, a Pay with Venmo button, a QR code and the code', /data\.venmo && data\.venmo\.link/.test(ap) && /id="venmo-pay-qr"/.test(ap) && /Your code/.test(ap) && /<script src="\/js\/venmo\.js"><\/script>/.test(ap));
check('signup: before submitting, it says the button comes after', /a Venmo button with your amount and code/.test(ap));
const ma = read('supabase/functions/member_auth/index.ts');
check('member app: parties and keyfobs carry their codes', /payment_status, price_cents, admin_notes, decided_at, event_id, created_at, venmo_code/.test(ma) && /requested_at, issued_at, lost_at, venmo_code/.test(ma));
const mi = read('m/index.html');
check('member app: Pay with Venmo on parties and keyfobs', /PoolsideVenmo\.link\(/.test(mi) && /venmoPayLink\('party', b\.price_cents, b\.venmo_code\)/.test(mi) && /venmoPayLink\(unpaid\.length === 1 \? 'keyfob' : 'keyfobs', due/.test(mi) && /<script src="\/js\/venmo\.js"><\/script>/.test(mi));

console.log('BC1 · the board sees it, and confirms in a batch');
const mem = read('club/admin/members.html');
check('Signups: the Venmo pill and the Venmo check show the code', /a\.venmo_code/.test(mem) && /Look for/.test(mem));
check('Parties and Keyfobs show the code', /venmo_code/.test(read('club/admin/parties.html')) && /venmo_code/.test(read('club/admin/keyfobs.html')));
const pa = read('supabase/functions/payments_admin/index.ts');
check('payments_admin lists every Venmo waiting: signups, parties, keyfobs', /action === 'venmo_waiting'/.test(pa) && /kind: 'signup'/.test(pa) && /kind: 'party'/.test(pa) && /kind: 'keyfob'/.test(pa));
const pay = read('club/admin/payments.html');
check('Payments: "Venmo to check" with boxes and Confirm selected', /id="venmo-check"/.test(pay) && /Confirm selected/.test(pay) && /venmo_waiting/.test(pay));
check('confirming runs each one\'s own step', /'approve', \{ id: it\.id, verify_venmo_payment: true \}/.test(pay) && /'verify_payment', \{ id: it\.id, method: 'venmo' \}/.test(pay) && /'confirm_venmo', \{ id \}/.test(pay));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

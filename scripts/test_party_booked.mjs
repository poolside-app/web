#!/usr/bin/env node
// Targeted check for telling the party person about every paid party
// (PLAN.md AE). Offline: reads the code and runs the message builders.
//
// Usage: node scripts/test_party_booked.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 300);

console.log('AE1 · the party person hears about every paid party (offline)');
let pb = null;
try { pb = await importTs(new URL('supabase/functions/_shared/party_booked.ts', root)); } catch (e) { check('the messages live in _shared/party_booked.ts', false, e.message); }
if (pb) {
  const party = { title: 'Brooks birthday', starts_at: '2027-06-20T21:00:00Z', ends_at: '2027-06-21T00:00:00Z', expected_guests: 25, price_cents: 25000 };
  const who = { name: 'Linda Brooks', phone_e164: '+15551234567', email: 'linda@example.com' };
  const s = pb.bookedSummary(party, 'Brooks Family', who, 'card', 'America/Los_Angeles');
  check('the to-do says the party, when, guests, how it was paid, and who to call', /Brooks birthday/.test(s) && /Jun 20/.test(s) && /2(:00)?\s?PM/.test(s) && /25 guests/.test(s) && /card/.test(s) && /Linda Brooks/.test(s) && /\(555\) 123-4567/.test(s), s);
  const v = pb.bookedSummary(party, 'Brooks Family', { name: 'Linda Brooks' }, 'venmo', 'America/Los_Angeles');
  check('without a phone it still names who to get in touch with', /Linda Brooks/.test(v) && /Venmo/.test(v) && !/undefined|null/.test(v), v);
  const html = pb.bookedEmailHtml(party, 'Brooks Family', who, 'card', 'America/Los_Angeles', 'https://bishopestates.poolsideapp.com');
  check('the email has tap-to-call, text and email for the family', /href="tel:\+15551234567"/.test(html) && /href="sms:\+15551234567"/.test(html) && /href="mailto:linda@example\.com"/.test(html) && /club\/admin\/parties\.html/.test(html));
  check('names and notes are escaped in the email', !/<script>/.test(pb.bookedEmailHtml({ ...party, title: '<script>x</script>' }, 'F', who, 'card', 'America/Los_Angeles', 'https://x')));
}
const pos = await importTs(new URL('supabase/functions/_shared/positions.ts', root));
check('it goes to the party person (the rentals alert)', pos.TASK_NOTICE['party.booked'] === 'rentals');
const wh = read('supabase/functions/stripe_webhook/index.ts');
check('paid by card: the webhook sends it', /partyBookedAlert\([^)]*'card'/.test(wh.slice(wh.indexOf("kind === 'party_booking'"))));
const pa = read('supabase/functions/parties_admin/index.ts');
check('a Venmo the board approves: sends it', /partyBookedAlert\(/.test(pa.slice(pa.indexOf("action === 'verify_payment'"), pa.indexOf("action === 'reject'"))));
const ma = read('supabase/functions/member_auth/index.ts');
check('free at an open time: sends it', /partyBookedAlert\([^)]*'free'/.test(ma));
const pbSrc = read('supabase/functions/_shared/party_booked.ts');
check('a to-do, a pop-up (from the task) and an email to whoever gets the rentals alert', /enqueueAdminTask\(/.test(pbSrc) && /push_title/.test(pbSrc) && /recipientsFor\([^)]*'rentals'\)/.test(pbSrc) && /sendEmail\(/.test(pbSrc));
check('the board home shows it as "Party booked"', /party\\\.booked/.test(read('club/admin/index.html')));

console.log('AE2 · the family asks the board (offline)');
const et = read('supabase/functions/_shared/email_template.ts');
const conf = et.slice(et.indexOf("key: 'party_confirmed'"), et.indexOf("key: 'party_rejected'"));
check('"Your party is booked" points them to Ask the board → Parties & events', /Ask the board/.test(conf) && /Parties &amp; events|Parties & events/.test(conf));

console.log('AE3 · the Parties page (offline)');
const pp = read('club/admin/parties.html');
check('the family\'s phone and email are tap-to-call, text and email', /function contactLinks/.test(pp) && /`tel:\$\{tel\}`/.test(pp) && /`sms:\$\{tel\}`/.test(pp) && /`mailto:\$\{r\.email\}`/.test(pp) && /\$\{contactLinks\(b\.requester\)\}/.test(pp));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Targeted check for the money fixes (PLAN.md BG3, from the 10/20 audit):
// refunds and chargebacks on every kind of card payment reach the Treasurer
// as a to-do (nothing undone by itself, Doug 10/20); the old Mark paid
// buttons run the real confirm step; a card donation adds to the board's
// outside amount; donations follow Test payments; late fees are gone ("no
// late fees on here... remove it"). Offline: the rules and the wiring.
//
// Usage: node scripts/test_money_fixes.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const migs = pat => readdirSync(new URL('supabase/migrations/', root)).filter(f => pat.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const hook = read('supabase/functions/stripe_webhook/index.ts');

console.log('BG3 · refunds and chargebacks on every card payment');
const match = existsSync(new URL('supabase/functions/_shared/payment_match.ts', root)) ? read('supabase/functions/_shared/payment_match.ts') : '';
check('one matcher finds the payment behind a refund or chargeback', /export async function matchPayment/.test(match));
for (const t of ['payment_plan_installments', 'party_bookings', 'keyfobs', 'program_bookings', 'donations']) {
  check(`  it looks in ${t}`, new RegExp(`from\\('${t}'\\)`).test(match));
}
check('it falls back to the club that owns the Stripe account', /stripe_account_id/.test(match));
const refundBranch = (hook.split("if (type === 'charge.refunded')")[1] || '').split("if (type === 'charge.dispute.created')")[0];
const disputeBranch = (hook.split("if (type === 'charge.dispute.created')")[1] || '').split("if (type === 'payment_intent.payment_failed')")[0];
const helper = (hook.split('async function paymentProblemTask')[1] || '').split('Deno.serve(')[0];
check('the to-do helper matches the payment and makes a Treasurer to-do', /matchPayment\(/.test(helper) && /enqueueAdminTask\(/.test(helper) && /target_scopes: \['payments'\]/.test(helper));
check('a refund on anything but a signup gives the Treasurer a to-do', /paymentProblemTask\(/.test(refundBranch) && /payment\.refund/.test(refundBranch));
check('a chargeback on anything but a signup gives the Treasurer a to-do', /paymentProblemTask\(/.test(disputeBranch) && /payment\.dispute/.test(disputeBranch));
check('both to-dos go to whoever handles payments', /'payment\.refund': 'payments'/.test(read('supabase/functions/_shared/positions.ts')) && /'payment\.dispute': 'payments'/.test(read('supabase/functions/_shared/positions.ts')));
check('nothing is undone by itself (to-do only)', !/dues_paid_for_year:\s*false/.test(refundBranch + disputeBranch + helper) && !/status:\s*'cancel/.test(refundBranch + disputeBranch + helper));
check('the payment id is kept for parties, fobs and programs',
  /party_bookings add column if not exists stripe_payment_intent_id/.test(migs(/payment_intents/))
  && /keyfobs add column if not exists stripe_payment_intent_id/.test(migs(/payment_intents/))
  && /program_bookings add column if not exists stripe_payment_intent_id/.test(migs(/payment_intents/)));
const csc = (hook.split("if (type === 'checkout.session.completed')")[1] || '').split("if (type === 'charge.refunded')")[0];
check('the webhook records it when a party, fob or program is paid', (csc.match(/stripe_payment_intent_id: piAll/g) || []).length >= 3, String((csc.match(/stripe_payment_intent_id: piAll/g) || []).length));

console.log('BG3 · Mark paid runs the real confirm step');
const pa = read('supabase/functions/payments_admin/index.ts');
check('a signup goes through applications verify_payment', /forward\('applications', \{ action: 'verify_payment'/.test(pa));
check('a party goes through parties_admin verify_payment', /forward\('parties_admin', \{ action: 'verify_payment'/.test(pa));
check('no shortcut writes "paid" on a signup or party', !/from\('applications'\)\s*\.update\(\{\s*payment_status: 'paid'/.test(pa) && !/from\('party_bookings'\)\.update\(\{\s*payment_status: 'paid'/.test(pa));

console.log('BG3 · the fundraiser');
let f = null;
try { f = await importTs(new URL('supabase/functions/_shared/fundraiser.ts', root)); } catch (e) { check('the rule lives in _shared/fundraiser.ts', false, e.message); }
if (f) {
  check('the thermometer = recorded donations + what the board raised outside', f.fundraiserRaised({ outside_cents: 100000 }, 2500) === 102500);
  check('no outside amount: just the donations', f.fundraiserRaised({}, 2500) === 2500);
}
check('every donation path uses it (webhook and donations)', /recomputeFundraiser\(/.test(hook) && /recomputeFundraiser\(/.test(read('supabase/functions/donations/index.ts')));
const dHtml = read('club/admin/donations.html');
check('the board types "Raised outside Poolside", not an override', /Raised outside Poolside/.test(dHtml) && /outside_cents/.test(dHtml) && !/You can override/.test(dHtml));
check('Bishop\'s typed $1,000 is kept as its outside amount', /outside_cents/.test(migs(/fundraiser_outside/)));

console.log('BG3 · test donations');
const don = read('supabase/functions/donations/index.ts');
check('donations go to the test checkout while Test payments is on', /clubInTestMode\(/.test(don) && /simulatedCheckoutUrl\(/.test(don));
check('one test-checkout builder, shared', existsSync(new URL('supabase/functions/_shared/sim_checkout.ts', root))
  && /from '\.\.\/_shared\/sim_checkout\.ts'/.test(read('supabase/functions/stripe_checkout/index.ts')));

console.log('BG3 · no late fees');
check('Money setup has no Late fees card', !/late-fee-card|Late fees/.test(read('club/admin/payments.html')));
check('no late-fee actions on the server', !/late_fee/.test(pa));
check('the daily run doesn\'t assess them', !/late_fee/.test(read('supabase/functions/payment_plans/index.ts')));
check('no late-fee help article', !existsSync(new URL('club/admin/help/articles/late-fees.md', root)) && !/late-fees/.test(read('club/admin/help.html')));
check('the fees page doesn\'t mention them', !/[Ll]ate fee/.test(read('fees.html')));
check('no late-fee rate', !/\blate:\s*\d/.test(read('supabase/functions/_shared/fees.ts')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

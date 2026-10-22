#!/usr/bin/env node
// Targeted check for the referral rule (PLAN.md BJ5, Doug's demo walkthrough
// list, 10/21): a referral counts only if the new family wasn't a member last
// season, matched by phone, email or street address; the family is told why,
// the board sees it and can count it anyway. Offline: runs the rule and reads
// the code.
//
// Usage: node scripts/test_referral_rule.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
const between = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, s.indexOf(b, i + a.length) < 0 ? undefined : s.indexOf(b, i + a.length)); };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };

console.log('BJ5 · the rule (_shared/referral_eligibility.ts)');
let re = null;
try { re = await importTs(new URL('supabase/functions/_shared/referral_eligibility.ts', root)); } catch { /* checked below */ }
check('the rule exists', !!re?.matchLastSeason);
if (re?.matchLastSeason) {
  const n = re.normalizeAddress;
  check('  addresses match however they\'re typed', n('14 Willow Lane') === n('14 willow ln.') && n('9 Birch Court, Apt 2') === n('9 BIRCH CT APT 2') && n('') === '');
  check('  different houses don\'t', n('14 Willow Lane') !== n('41 Willow Lane'));
  const homes = [
    { family_name: 'Smith Family', paid_until_year: 2026, address: '14 Willow Lane', emails: ['pat@example.com'], phones: ['+15555550101'] },
    { family_name: 'Lee Family', paid_until_year: 2025, address: '3 Elm Court', emails: ['kim@example.com'], phones: ['+15555550202'] },
    { family_name: 'Ortiz Family', paid_until_year: 2027, address: '6 Aspen Court', emails: [], phones: ['+15555550303'] },
  ];
  const m = a => re.matchLastSeason({ emails: [], phones: [], address: null, ...a }, homes, 2026);
  check('  last season\'s member by phone', m({ phones: ['+15555550101'] })?.family === 'Smith Family' && m({ phones: ['+15555550101'] })?.by === 'phone');
  check('  by email, any case', m({ emails: ['PAT@example.com'] })?.by === 'email');
  check('  by street address', m({ address: '14 willow ln' })?.by === 'address');
  check('  a family that lapsed two seasons ago counts', m({ phones: ['+15555550202'], emails: ['kim@example.com'], address: '3 Elm Ct' }) === null);
  check('  this season\'s member doesn\'t', m({ phones: ['+15555550303'] })?.season === 2027);
  check('  a new family counts', m({ phones: ['+15555550999'], emails: ['new@example.com'], address: '1 New Road' }) === null);
  check('  the board\'s reason: "Member in 2026: same address as the Smith Family"', re.boardReason(m({ address: '14 Willow Ln' })) === 'Member in 2026: same address as the Smith Family', re.boardReason(m({ address: '14 Willow Ln' })));
  check('  the family\'s message says the rule, not what matched', /weren't members here last season/.test(re.FAMILY_MESSAGE) && !/Smith|address|phone/.test(re.FAMILY_MESSAGE));
}

console.log('BJ5 · used everywhere a referral counts');
const price = read('supabase/functions/_shared/membership_price.ts');
check('the $25 off at signup uses it, with the address', /lastSeasonMember/.test(between(price, 'export async function referralOff', '\n}\n')) && /address/.test(between(price, 'export async function referralOff', '\n}\n')));
check('"ever a member" is gone', !/export async function wasMember/.test(price) && !/function isEligibleNewMember/.test(read('supabase/functions/referrals/index.ts')));
check('the price says why there\'s no referral discount', /referral_problem/.test(price));
const apps = read('supabase/functions/applications/index.ts');
const capture = between(apps, 'Referral capture', 'Render the legal-evidence PDF');
check('signup records a referral that doesn\'t count, with the board\'s reason', /lastSeasonMember/.test(capture) && /'rejected'/.test(capture) && /boardReason/.test(capture));
check('the signup form gets the reason (publicPrice passes it on)', /referral_problem: p\.referral_problem/.test(between(apps, 'function publicPrice', '\n}\n')));
check('the quote sends the address', /address: strOrNull\(body\.address\)|address:/.test(between(apps, "action === 'quote'", 'quotePlan')));
const refs = read('supabase/functions/referrals/index.ts');
check('the reward uses it when the family pays', /lastSeasonMember/.test(between(refs, "action === 'verify_referral'", "action === 'unlock_due'")) || /lastSeasonMember/.test(refs.slice(refs.indexOf('async function verifyReferral'))));
check("'Count it anyway' needs the payments permission and is recorded", /action === 'count_anyway'/.test(refs) && /requireScope[\s\S]{0,200}'payments'/.test(between(refs, "action === 'count_anyway'", 'return jsonResponse({ ok: true')) && /override_by/.test(refs));
check('a counted-anyway referral skips the rule when the family pays', /override_at/.test(refs));
check('only a current member gets a referral link', /householdStatus/.test(between(refs, "action === 'get_my_code'", 'referral_codes')) && /current members/.test(between(refs, "action === 'get_my_code'", 'referral_codes')));
const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /referral_override/.test(f)).map(f => read('supabase/migrations/' + f)).join('\n');
check('referrals keep who counted it anyway', /override_by/.test(mig) && /override_at/.test(mig));
check("the member app's wording", /weren't members here last season/.test(read('m/index.html')) && !/never been members/.test(read('m/index.html')));
const pay = read('club/admin/payments.html');
check("the board's list: the reason and Count it anyway", /Count it anyway/.test(pay) && /count_anyway/.test(pay) && /Doesn't count/.test(pay));
check('the signup form shows the reason', /referral_problem/.test(read('apply.html')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

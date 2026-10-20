#!/usr/bin/env node
// Targeted check for the signup fixes (PLAN.md BG4, from the 10/20 audit):
// families stop at 8 people (Doug 10/20); a paid card signup that can't be
// approved opens a to-do; a plan signup gets its Sign in button; a level can
// say how many people it covers; unpaid card signups are checked with Stripe
// before they're deleted; a released party paid late is re-booked; the
// welcome text goes whenever there's a phone; policies are recorded by the
// club's own list. Offline: the rules and the wiring.
//
// Usage: node scripts/test_signup_fixes.mjs
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

const apply = read('apply.html');
const apps = read('supabase/functions/applications/index.ts');
const hook = read('supabase/functions/stripe_webhook/index.ts');
const submit = (apps.split("if (action === 'submit')")[1] || '').split("if (action === '")[0];

console.log('BG4 · families stop at 8 (item 9)');
check('the form stops at 8 people and says to ask the board', /MAX_PEOPLE = 8/.test(apply) && /Up to 8 people per membership/.test(apply));
check('the server refuses more than 8 too', /MAX_PEOPLE_PER_HOUSEHOLD = 8/.test(apps) && /Up to 8 people per membership/.test(apps));

console.log('BG4 · a paid card signup that can\'t be approved (item 10)');
check('the board gets a to-do with the reason', /application\.approve_failed/.test(hook) && /couldn.t be approved/i.test(hook));
const appBranch = (hook.split("if (kind === 'application' && md.application_id)")[1] || '').split("// ── Payment plans")[0];
const closeAt = appBranch.indexOf("// Close any related admin tasks");
const taskAt = appBranch.indexOf('approveFailedTask(');
check('…opened after the step that closes the signup\'s to-dos', closeAt > 0 && taskAt > closeAt, `${closeAt} ${taskAt}`);
check('…for plan signups too', /approveFailedTask\(/.test((hook.split("kind === 'payment_plan_first' || kind === 'payment_plan_setup'")[1] || '').slice(0, 4000)));
check('it goes to the signups person', /'application\.approve_failed': 'signups'/.test(read('supabase/functions/_shared/positions.ts')));

console.log('BG4 · the plan signup\'s Sign in button (item 11)');
check('the webhook stamps when a plan starts', /plan_started_at: now/.test(hook) && /applications add column if not exists plan_started_at/.test(migs(/plan_started/)));
const pps = (apps.split("if (action === 'post_payment_signin')")[1] || '').split("if (action === '")[0];
check('the sign-in button accepts a plan\'s start as the payment time', /plan_started_at/.test(pps));

console.log('BG4 · levels say how many people they cover (item 18)');
let fit = null;
try { fit = await importTs(new URL('supabase/functions/_shared/tier_fit.ts', root)); } catch (e) { check('the rule lives in _shared/tier_fit.ts', false, e.message); }
if (fit) {
  const tiers = [{ slug: 'family', label: 'Family' }, { slug: 'single', label: 'Single', max_people: 1 }];
  check('Single fits one person', fit.tierFitError(tiers, 'single', 1) === null);
  check('Single doesn\'t fit four, and says why', /covers 1 person/.test(fit.tierFitError(tiers, 'single', 4) || ''), fit.tierFitError(tiers, 'single', 4));
  check('a level with no limit fits anyone', fit.tierFitError(tiers, 'family', 8) === null);
}
check('signup refuses a level that doesn\'t fit', /tierFitError\(/.test(submit));
check('the form greys out levels that don\'t fit', /max_people/.test(apply) && /\.disabled = /.test(apply.split('function applyTierDefault')[1] || ''));
check('Money setup has "Covers up to" per level', /Covers up to/.test(read('club/admin/payments.html')) && /max_people/.test(read('club/admin/payments.html')));
check('Bishop\'s Single covers one person', /max_people/.test(migs(/tier_max_people/)));

console.log('BG4 · unpaid card signups (item 19)');
const cleanup = (apps.split("if (action === 'cron_cleanup_abandoned')")[1] || '').split("if (action === '")[0];
check('waits 24 hours, not 60 minutes', /24 \* 60 \* 60 \* 1000/.test(cleanup) && !/60 \* 60 \* 1000\)\.toISOString/.test(cleanup.replace('24 * 60 * 60 * 1000', '')));
check('asks Stripe first and keeps a paid one', /checkout\/sessions\//.test(cleanup) && /payment_status === 'paid'/.test(cleanup));

console.log('BG4 · a released party paid late (item 20)');
const party = (hook.split("if (kind === 'party_booking' && md.party_id && tenantId)")[1] || '').split("// Fundraiser donations")[0];
check('re-booked when the time is still free', /released/.test(party) && /status: 'approved'/.test(party));
check('a canceled or turned-down party paid late gets a refund to-do', /party\.refund_needed/.test(party) && /rejected/.test(party));

console.log('BG4 · the welcome text (item 21)');
check('approval texts the family whenever there\'s a phone', /if \(app\.primary_email \|\| app\.primary_phone\)/.test(apps));

console.log('BG4 · policies by the club\'s own list (item 13)');
check('no fixed list of five policy names', !/\['rules','guest','party','sitter','waiver'\]/.test(apps));
check('signup reads the club\'s active policies', /from\('policies'\)/.test(submit) && /required_for_apply/.test(submit));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

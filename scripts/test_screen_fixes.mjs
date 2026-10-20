#!/usr/bin/env node
// Targeted check for the screen and help fixes (PLAN.md BG6, from the 10/20
// audit): the signup form's wording and debug code, Plan & billing for a
// club on a set plan, three layout slips, plain words, small polish, and the
// help articles. Offline: reads the pages and articles.
//
// Usage: node scripts/test_screen_fixes.mjs
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BG6 · the signup form (items 29, 43)');
const apply = read('apply.html');
check('no promise of board review, a phone pool pass or "magic-link"', !/goes to the board for review/.test(apply) && !/Pool pass on phone/.test(apply) && !/magic-link sign-in when/.test(apply));
check('the step counter sits above the title', /<div class="step-counter">Step <span id="step-num">1<\/span> of 4<\/div>\s*<h1 id="title">/.test(apply));
check('no "for invoices", no old version stamp', !/for invoices/.test(apply) && !/v\.2026-05-03b/.test(apply));
check('no debug tap counter; errors read as a sentence', !/__tapCount/.test(apply) && !/show\('Error: '/.test(apply));

console.log('BG6 · Plan & billing (item 32)');
const bill = read('club/admin/billing.html');
check('a club on a set plan sees no tiers, upgrades or setup to buy', /for \(const id of \['plans-card', 'upgrade-card', 'setup-card', 'buy-texts-row'\]\)/.test(bill));

console.log('BG6 · layout slips (item 33)');
check('Privacy and Terms wrap long addresses', ['privacy.html', 'terms.html'].every(f => /code \{ overflow-wrap: anywhere/.test(read(f))));
check('the Announcements header stacks on a phone', /\.toolbar-actions \{ width: 100%; \}/.test(read('club/admin/announcements.html')));
check('no "No open balances ." typo', !/No open balances \$\{FILTER/.test(read('club/admin/payments.html')));

console.log('BG6 · plain words (item 34)');
const all = ['club/admin/payments.html', 'club/admin/billing.html', 'club/admin/settings.html', 'js/admin-subtabs.js', 'club/admin/policies.html', 'm/family.html'].map(read).join('\n');
for (const w of ['pending verify', 'blast past members', 'blast to everybody', 'which modules', 'Known $ owed', 'gated checkboxes', 'gates the signup form', 'Danger zone', "label: 'Pipeline'"]) {
  check(`  no "${w}"`, !all.includes(w));
}

console.log('BG6 · polish (item 44)');
check('the Programs card only for a club with programs', /if \(HAS_PROGRAMS\) refreshPrograms\(\)/.test(read('m/index.html')));
check('four banner numbers sit two by two on a phone', /\.hero-stats\.n4 \{ grid-template-columns: repeat\(2, 1fr\)/.test(read('club/admin/index.html')));
check('Change password has the board tabs and bottom bar', /admin-subtabs\.js/.test(read('club/admin/change-password.html')));

console.log('BG6 · help (items 31, 41)');
const art = f => existsSync(new URL(`club/admin/help/articles/${f}`, root)) ? read(`club/admin/help/articles/${f}`) : '';
check('"yearly" text allowance, not monthly', !/monthly text allowance/.test(art('text-all-members.md') + art('send-renewal-blast.md')) && /yearly allowance/.test(read('supabase/functions/tenant_admin_auth/index.ts')));
check('the Venmo article covers codes and Venmo to check', /Venmo to check/.test(art('confirm-venmo-payment.md')) && /#K7Q2/.test(art('confirm-venmo-payment.md')));
check('the refund article says to untick Dues paid', /untick \*\*Dues paid for current year\*\*/.test(art('refund-a-payment.md')));
check('start-next-season no longer reads as "plan families are locked out"', !/or on a plan, can only use/.test(art('start-next-season.md')));
for (const f of ['check-in.md', 'venmo-code.md', 'cancel-party-or-fob.md', 'who-gets-alerts.md', 'text-allowance.md']) {
  check(`  new article ${f}`, !!art(f) && read('club/admin/help.html').includes(`'${f}'`));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

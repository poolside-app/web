#!/usr/bin/env node
// Targeted check for the website and console fixes (PLAN.md BG7, from the
// 10/20 audit): one Setup price ($500 up to 100 households, $750 above; Doug
// 9/9), the signup page's sign-in link, one contact address, the provider
// console's wording, a limit on new clubs, and the old mockups gone. The
// home page has its own check (test_home_page.mjs). Offline.
//
// Usage: node scripts/test_site_fixes.mjs
import { readFileSync, existsSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BG7 · one Setup price (item 26)');
const pages = ['pricing.html', 'setup-service.html', 'fees.html'].map(read).join('\n');
check('no "$1 per household past 200" or "$500 flat"', !/\$1 per household/.test(pages) && !/\$500 flat/.test(pages));
check('every page says $750 above 100 households', ['pricing.html', 'setup-service.html', 'fees.html'].every(f => /\$750/.test(read(f))));
const tad = read('supabase/functions/tenant_admin_auth/index.ts');
check('the checkout charges by size', /const setupCents = \(hhCount \?\? 0\) > 100 \? 75000 : 50000/.test(tad));
check('Plan & billing shows the right price', /\(u\.count \|\| 0\) > 100 \? 750 : 500/.test(read('club/admin/billing.html')));

console.log('BG7 · the signup page (item 27)');
const signup = read('signup.html');
check('no "Provider sign in" link to Poolside\'s own console', !/Provider sign in/.test(signup) && !/href="\/admin\/login\.html"/.test(signup));
check('a box that goes to your club\'s board sign-in', /poolsideapp\.com\/club\/admin\/login\.html/.test(signup));

console.log('BG7 · one contact address (item 35)');
const pub = ['privacy.html', 'terms.html', 'signup.html', 'setup-service.html', 'club/admin/billing.html', 'admin/index.html'].map(read).join('\n');
check('public pages use support@poolsideapp.com only', !/hello@poolsideapp\.com|doug@poolsideapp\.com|doug\.frevele@gmail\.com/.test(pub) && /support@poolsideapp\.com/.test(pub));

console.log('BG7 · your console (item 36)');
const gi = read('admin/gate-integrations.html');
check('no "Pi bridge" or "on the Pi"', !/Pi bridge|on the Pi|the Pi'|on-site Pi/.test(gi));
check('the retired templates tab is hidden', !/data-tab="templates" onclick/.test(gi));
check('no supabase.exe instructions', !/<code>tools\/supabase\.exe secrets set/.test(read('admin/index.html')));

console.log('BG7 · a limit on new clubs (item 40)');
const ts = read('supabase/functions/tenant_signup/index.ts');
check('3 an hour from one place, 2 a day per email', /\(byIp \?\? 0\) >= 3 \|\| \(byEmail \?\? 0\) >= 2/.test(ts) && /kind: 'tenant\.self_signup'/.test(ts));

console.log('BG7 · old mockups (item 43)');
check('/club-demo/ is gone', !existsSync(new URL('club-demo/index.html', root)));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

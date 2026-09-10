#!/usr/bin/env node
// =============================================================================
// errors_test.mjs — prove the error reporter never ships a credential
// =============================================================================
// js/errors.js sends JavaScript errors to Sentry. A member's sign-in token
// lives in the URL fragment of /m/verify.html, and Sentry attaches the page
// URL to every event by default — so without scrubbing this would publish
// working sign-in links for real families to a third party and call it
// monitoring. These tests exist so that cannot regress unnoticed.
//
//   node scripts/errors_test.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src  = readFileSync(join(here, '..', 'js', 'errors.js'), 'utf8');

// Smallest browser the script will run against.
const listeners = {};
const win = {
  location: { pathname: '/m/verify.html', href: 'https://bishopestates.poolsideapp.com/m/verify.html', hostname: 'bishopestates.poolsideapp.com', origin: 'https://bishopestates.poolsideapp.com' },
  addEventListener: (k, fn) => { listeners[k] = fn; },
  URL,
};
const doc = { createElement: () => ({ style: {} }), head: { appendChild() {} } };
new Function('window', 'document', 'URL', src)(win, doc, URL);

const { url: scrubUrl, text: scrubText } = win.__poolsideScrub;

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = got === want; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n        got  ${got}\n        want ${want}`}`);
};
const clean = (name, got, needle) => {
  const ok = !String(got).includes(needle); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  LEAKED ${needle} in: ${got}`}`);
};

console.log('— the one that matters: sign-in links —');
clean('magic-link fragment stripped',
  scrubUrl('https://bishopestates.poolsideapp.com/m/verify.html#token=abc123SECRET'), 'abc123SECRET');
clean('token in query stripped',
  scrubUrl('https://x.poolsideapp.com/m/?token=abc123SECRET&a=1'), 'abc123SECRET');
clean('claim token stripped',
  scrubUrl('https://x.poolsideapp.com/apply.html?claim=SECRETCLAIM'), 'SECRETCLAIM');
clean('unparseable url still scrubbed',
  scrubUrl('not a url at all ?token=SECRETTOK'), 'SECRETTOK');

console.log('— member data out of messages —');
clean('JWT redacted', scrubText('failed with eyJhbGciOi.eyJzdWIiOiJ4.SIGNATUREHERE'), 'SIGNATUREHERE');
clean('email redacted', scrubText('could not reach jane.smith@example.com'), 'jane.smith@example.com');
clean('phone redacted', scrubText('sms to (925) 555-1234 failed'), '555-1234');
clean('6-digit code redacted', scrubText('code 481920 rejected'), '481920');

console.log('— it still says something useful —');
t('ordinary message survives', scrubText('Cannot read properties of null'), 'Cannot read properties of null');
{
  const u = scrubUrl('https://bishopestates.poolsideapp.com/club/admin/members.html?tab=applications');
  t('harmless query kept', u.includes('tab=applications'), true);
  t('path kept', u.includes('/club/admin/members.html'), true);
}
t('null-safe url', scrubUrl(''), '');
t('null-safe text', scrubText(undefined), undefined);

console.log('— the handlers are actually installed —');
t('error handler registered', typeof listeners.error, 'function');
t('rejection handler registered', typeof listeners.unhandledrejection, 'function');
{
  listeners.error({ message: 'boom eyJa.eyJb.SIGSIG', lineno: 12, filename: 'https://x/m/?token=SECRETTOK' });
  const e = win.__poolsideErrors[win.__poolsideErrors.length - 1];
  clean('captured message scrubbed', e.message, 'SIGSIG');
  clean('captured source scrubbed', e.source, 'SECRETTOK');
  t('surface tagged', e.surface, 'member');
  t('club tagged', e.club, 'bishopestates');
}
{
  const before = win.__poolsideErrors.length;
  listeners.error({ message: 'boom eyJa.eyJb.SIGSIG', lineno: 12, filename: 'x' });
  t('duplicate not recorded twice', win.__poolsideErrors.length, before);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

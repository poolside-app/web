#!/usr/bin/env node
// =============================================================================
// terms_test.mjs — what a member is told before we keep their card
// =============================================================================
// Stripe writes mandate text for ACH and SEPA but not for a card saved during
// a one-off payment, which is what Poolside does. That disclosure is ours, and
// their requirement for off-session charges is that the member agreed to us
// initiating payments and was told the timing and frequency, how the amount is
// decided, and how to cancel.
//
//   https://docs.stripe.com/payments/save-and-reuse
//
// These tests check all four are actually said, because the failure mode is
// silent: nothing breaks, the charges work, and the club loses the first
// dispute it ever gets.
//
//   node scripts/terms_test.mjs
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'poolside-terms-'));
copyFileSync(join(here, '..', 'supabase', 'functions', '_shared', 'payment_terms.ts'), join(work, 'payment_terms.ts'));
execFileSync('npx', ['--yes', '-p', 'typescript@5.6.3', 'tsc', join(work, 'payment_terms.ts'),
  '--target', 'es2022', '--module', 'esnext', '--outDir', join(work, 'out'), '--skipLibCheck'], { stdio: 'pipe' });
renameSync(join(work, 'out', 'payment_terms.js'), join(work, 'out', 'payment_terms.mjs'));
const { autoRenewTerms, planTerms, termsRecord, authorizationSentence, TERMS_VERSION } =
  await import(pathToFileURL(join(work, 'out', 'payment_terms.mjs')).href);

let pass = 0, fail = 0;
const t = (name, got, want) => { const ok = got === want; ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n        got  ${got}\n        want ${want}`}`); };
const says = (name, text, re) => { const ok = re.test(text); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  not found: ${re}`}`); };

const CLUB = 'Bishop Estates Cabana Club';

console.log('— auto-renew says all four things —');
{
  const text = autoRenewTerms({ clubName: CLUB, currentDuesCents: 60000, year: 2027 }).join('\n');
  says('who initiates the charge',   text, /Bishop Estates Cabana Club will charge/i);
  says('timing and frequency',       text, /once a year/i);
  says('when, specifically',         text, /2027 dues open/i);
  says('how the amount is decided',  text, /whatever your membership costs that season/i);
  says('and it can change',          text, /can change/i);
  says('a concrete figure to anchor', text, /\$600/);
  says('advance notice',             text, /14 days before/i);
  says('how to cancel',              text, /turn it off/i);
  says('and where',                  text, /My family/i);
}

console.log('— a club with no price set still gets honest terms —');
{
  const text = autoRenewTerms({ clubName: CLUB, currentDuesCents: 0 }).join('\n');
  says('still says how the amount is decided', text, /whatever your membership costs/i);
  t('and invents no figure', /\$\d/.test(text), false);
  says('falls back to next season',           text, /next season/i);
}

console.log('— payment plans —');
{
  const text = planTerms({
    clubName: CLUB,
    installments: [
      { due_date: '2027-05-01', amount_cents: 15000 },
      { due_date: '2027-06-01', amount_cents: 15000 },
      { due_date: '2027-07-01', amount_cents: 15000 },
      { due_date: '2027-08-01', amount_cents: 15000 },
    ],
    perPaymentFeeCents: 400,
  }).join('\n');
  says('every date is listed',    text, /May 1.*June 1.*July 1.*August 1/s);
  says('every amount is listed',  text, /\$150\.00/);
  says('who charges it',          text, /Bishop Estates Cabana Club will charge/i);
  says('only the later ones',     text, /remaining 3 payments/i);
  says('nothing else on the card',text, /Nothing else is charged/i);
  says('advance notice',          text, /14, 7 and 1 days before/i);
  says('the fee is disclosed',    text, /\$4\.00 plan fee/i);
  says('how to stop it',          text, /contact your board/i);
}
{
  // Paying in full is not a stored credential, so it must not claim to be one.
  const single = planTerms({ clubName: CLUB, installments: [{ due_date: '2027-05-01', amount_cents: 60000 }] }).join('\n');
  t('no automatic-charge claim for a single payment', /will charge this card automatically/.test(single), false);
}
{
  const noFee = planTerms({ clubName: CLUB, installments: [
    { due_date: '2027-05-01', amount_cents: 30000 }, { due_date: '2027-07-01', amount_cents: 30000 }] }).join('\n');
  t('no fee mentioned when there is none', /plan fee/.test(noFee), false);
  says('one remaining payment reads correctly', noFee, /the remaining payment/i);
}

console.log('— what gets stored is what they saw —');
{
  const lines = autoRenewTerms({ clubName: CLUB, currentDuesCents: 60000, year: 2027 });
  const rec = termsRecord(lines, CLUB);
  for (const line of lines) says(`stored text keeps: "${line.slice(0, 34)}…"`, rec, new RegExp(line.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  says('and the agreement sentence', rec, /I authorize Bishop Estates Cabana Club to charge my saved card/);
  t('authorization names the club', authorizationSentence(CLUB).includes(CLUB), true);
  t('version is recorded', typeof TERMS_VERSION, 'number');
}

console.log('— the screens say the same thing as the record —');
{
  // A disclosure the member never reads is worth nothing, so check the actual
  // pages carry it and not just the module.
  for (const [file, label] of [['../apply.html', 'apply form'], ['../m/renew.html', 'renewal page']]) {
    // Collapse whitespace first: the disclosure wraps across several source
    // lines, and a browser renders it as one sentence regardless.
    const html = readFileSync(join(here, file), 'utf8').replace(/\s+/g, ' ');
    says(`${label}: frequency`,  html, /once a year/i);
    says(`${label}: amount rule`, html, /whatever your membership costs that season/i);
    says(`${label}: notice`,      html, /14 days before/i);
    says(`${label}: cancellation`, html, /My family/i);
    says(`${label}: authorizes`,  html, /authorizes those charges/i);
  }
  const fam = readFileSync(join(here, '../m/family.html'), 'utf8');
  says('family page can actually turn it off', fam, /Turn off automatic renewal/);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

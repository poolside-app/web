#!/usr/bin/env node
// =============================================================================
// sms_test.mjs — the promise that a blast costs $1.25 and no more
// =============================================================================
// A club's free season is 3,000 text segments. That is 20 messages to a
// 150-household club at one segment each, and 10 if messages quietly go to
// two — which one emoji or one apostrophe pasted from Notes is enough to do.
//
// These tests pin the arithmetic that promise rests on.
//
//   node scripts/sms_test.mjs
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'poolside-sms-'));
copyFileSync(join(here, '..', 'supabase', 'functions', '_shared', 'sms_text.ts'), join(work, 'sms_text.ts'));
execFileSync('npx', ['--yes', '-p', 'typescript@5.6.3', 'tsc', join(work, 'sms_text.ts'),
  '--target', 'es2022', '--module', 'esnext', '--outDir', join(work, 'out'), '--skipLibCheck'], { stdio: 'pipe' });
renameSync(join(work, 'out', 'sms_text.js'), join(work, 'out', 'sms_text.mjs'));
const { measureSms, normalizeForSms } = await import(pathToFileURL(join(work, 'out', 'sms_text.mjs')).href);

const HOUSEHOLDS = 150;
const RATE = 0.0083;
const FREE_ALLOWANCE = 3000;

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log('— what a club actually writes stays at one segment —');
for (const [name, body] of [
  ['closure',      'Bishop Estates: Pool closed today, storm damage. Update tomorrow morning.'],
  ['lessons',      'Bishop Estates: Swim lesson signups open Monday 9am. Spots go fast.'],
  ['hours',        'Bishop Estates: New hours from Monday - open 10am to 8pm daily.'],
  ['exactly 160',  'B'.repeat(160)],
]) t(name, measureSms(body).segments, 1);

t('161 characters tips over', measureSms('B'.repeat(161)).segments, 2);

console.log('— non-GSM characters drop the ceiling from 160 to 70 —');
// Not "an emoji doubles the cost" — the limit falls to 70, so a SHORT message
// with one is still a single segment. It is messages between 71 and 160
// characters that suddenly cost twice as much, which is most real ones.
t('short message with curly apostrophe still fits',
  measureSms("Pool closed. We\u2019ll update tomorrow.").segments, 1);
t('but the same text past 70 characters does not',
  measureSms("Pool closed today after storm damage. We\u2019ll post an update tomorrow morning.").segments, 2);
t('normalizing brings that back to one',
  measureSms(normalizeForSms("Pool closed today after storm damage. We\u2019ll post an update tomorrow morning.")).segments, 1);
t('em dash normalized',      measureSms(normalizeForSms('Open 10am \u2014 8pm daily from Monday, weather permitting, see you at the pool')).segments, 1);
t('ellipsis normalized',     measureSms(normalizeForSms('More details to follow soon\u2026 watch this space for the full summer schedule')).segments, 1);
t('curly quotes normalized', measureSms(normalizeForSms('\u201CPool closed\u201D today after storm damage, we will post an update tomorrow')).segments, 1);
t('normalizing does not change the words',
  normalizeForSms("We\u2019ll be closed \u2014 sorry\u2026"), "We'll be closed - sorry...");
// \u0101 is genuinely outside GSM-7. (\u00e9 is NOT — it is in the GSM basic
// set, along with a handful of other accented characters, so it costs nothing.)
t('70 UCS-2 units is still one', measureSms('\u0101'.repeat(70)).segments, 1);
t('71 is two',                   measureSms('\u0101'.repeat(71)).segments, 2);

console.log('— emoji, which normalizing cannot fix —');
{
  const long = '\u{1F3CA} Pool closed today after storm damage. We will post an update tomorrow morning.';
  const m = measureSms(long);
  t('forces UCS-2', m.encoding, 'UCS-2');
  t('a normal-length message costs two', m.segments, 2);
  t('reported as the offender', m.offenders.includes('\u{1F3CA}'), true);
  t('normalizing cannot rescue it', measureSms(normalizeForSms(long)).segments, 2);
  // Surrogate pairs are two UTF-16 units, which is how Twilio bills them.
  t('an emoji costs two of the 70', measureSms('\u{1F3CA}').chars, 2);
}

console.log('— the promise: $1.25 a blast, 20 blasts —');
{
  const body = 'Bishop Estates: Pool closed today, storm damage. Update tomorrow morning.';
  const seg = measureSms(body).segments;
  const used = seg * HOUSEHOLDS;
  t('one segment each', seg, 1);
  t('150 segments for the club', used, HOUSEHOLDS);
  t('costs $1.25', (used * RATE).toFixed(2), '1.25');
  t('free season buys 20 of them', Math.floor(FREE_ALLOWANCE / used), 20);
  t('and 20 of them costs $24.90', (FREE_ALLOWANCE * RATE).toFixed(2), '24.90');
}
console.log('— what it would have been without the cap —');
{
  const used = 2 * HOUSEHOLDS;
  t('two segments costs $2.49', (used * RATE).toFixed(2), '2.49');
  t('and the season halves to 10', Math.floor(FREE_ALLOWANCE / used), 10);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

#!/usr/bin/env node
// =============================================================================
// fees_test.mjs — unit tests for the platform fee math
// =============================================================================
// The only test in this repo that needs neither Supabase nor Stripe: it
// compiles _shared/fees.ts and exercises the pure functions directly.
//
// It exists because the fee path cannot be tested any other way right now —
// Stripe is on a test key with charges disabled — and being wrong here means
// either billing a club we promised not to bill, or quietly collecting
// nothing from one we meant to charge. Neither surfaces as an error.
//
//   node scripts/fees_test.mjs
// =============================================================================

import { execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src  = join(here, '..', 'supabase', 'functions', '_shared', 'fees.ts');

const work = mkdtempSync(join(tmpdir(), 'poolside-fees-'));
copyFileSync(src, join(work, 'fees.ts'));
execFileSync('npx', ['--yes', '-p', 'typescript@5.6.3', 'tsc', join(work, 'fees.ts'),
  '--target', 'es2022', '--module', 'esnext', '--outDir', join(work, 'out'), '--skipLibCheck'],
  { stdio: 'pipe' });
renameSync(join(work, 'out', 'fees.js'), join(work, 'out', 'fees.mjs'));

const {
  FEES_NORMAL, platformFeeCents, planFeeSchedule, planFeeTotal, feePolicyFromTenant,
} = await import(pathToFileURL(join(work, 'out', 'fees.mjs')).href);

let pass = 0, fail = 0;
const t = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const W = { waived: true }, N = FEES_NORMAL;

console.log('— a club we bill —');
t('dues 1% of $600',            platformFeeCents(60000, 'dues', N), 600);
t('programs 1.5% of $120',      platformFeeCents(12000, 'programs', N), 180);
t('donations always 0%',        platformFeeCents(50000, 'donations', N), 0);
t('4 payments cost the member $16', planFeeTotal(4, N), 1600);
t('8 payments still capped at $16', planFeeTotal(8, N), 1600);
t('paying once is not a plan',  planFeeSchedule(1, N), [0]);
t('fees floor, never round up', platformFeeCents(999, 'dues', N), 9);

console.log('— a club we do not bill —');
t('dues -> 0',                  platformFeeCents(60000, 'dues', W), 0);
t('programs -> 0',              platformFeeCents(12000, 'programs', W), 0);
t('unknown kind -> 0',          platformFeeCents(999999, 'default', W), 0);
t('plan fee -> 0',              planFeeTotal(4, W), 0);
t('schedule keeps its length',  planFeeSchedule(4, W), [0, 0, 0, 0]);
t('…at any length',             planFeeSchedule(8, W).length, 8);

console.log('— resolving a policy from a tenant row —');
t('flag set',        feePolicyFromTenant({ platform_fees_waived: true }),  { waived: true });
t('flag clear',      feePolicyFromTenant({ platform_fees_waived: false }), { waived: false });
t('no row',          feePolicyFromTenant(null),                            { waived: false });
t('column missing',  feePolicyFromTenant({}),                              { waived: false });

console.log('— an omitted policy must fail loudly, not bill quietly —');
for (const [name, fn] of [
  ['platformFeeCents', () => platformFeeCents(60000, 'dues')],
  ['planFeeSchedule',  () => planFeeSchedule(4)],
  ['planFeeTotal',     () => planFeeTotal(4)],
]) {
  try { fn(); fail++; console.log(`  FAIL ${name} returned instead of throwing`); }
  catch { pass++; console.log(`  ok   ${name} throws`); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

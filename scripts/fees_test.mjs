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

const here   = dirname(fileURLToPath(import.meta.url));
const shared = join(here, '..', 'supabase', 'functions', '_shared');

const work = mkdtempSync(join(tmpdir(), 'poolside-fees-'));
for (const f of ['fees.ts', 'fee_attribution.ts', 'referral_cap.ts']) copyFileSync(join(shared, f), join(work, f));
execFileSync('npx', ['--yes', '-p', 'typescript@5.6.3', 'tsc',
  join(work, 'fees.ts'), join(work, 'fee_attribution.ts'), join(work, 'referral_cap.ts'),
  '--target', 'es2022', '--module', 'esnext', '--outDir', join(work, 'out'), '--skipLibCheck'],
  { stdio: 'pipe' });
for (const f of ['fees', 'fee_attribution', 'referral_cap']) renameSync(join(work, 'out', `${f}.js`), join(work, 'out', `${f}.mjs`));

const {
  FEES_NORMAL, platformFeeCents, planFeeSchedule, planFeeTotal, feePolicyFromTenant,
} = await import(pathToFileURL(join(work, 'out', 'fees.mjs')).href);
const { attributeFee, emptyBuckets } = await import(pathToFileURL(join(work, 'out', 'fee_attribution.mjs')).href);
const { capState, grantableReward } = await import(pathToFileURL(join(work, 'out', 'referral_cap.mjs')).href);

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

// ── attribution: turning a Stripe Application Fee into "earned, on what" ──
const fee = (o) => ({ account: 'acct_1', amount: 0, amount_refunded: 0, ...o });
const charge = (metadata) => ({ metadata });

console.log('— reading one Stripe application fee —');
{
  const a = attributeFee(fee({ amount: 600, charge: charge({ kind: 'application' }) }));
  t('dues charge -> dues bucket', [a.bucket, a.bucketCents, a.planFeeCents], ['dues', 600, 0]);
}
{
  const a = attributeFee(fee({ amount: 180, charge: charge({ kind: 'program_booking' }) }));
  t('program -> programs bucket', [a.bucket, a.bucketCents], ['programs', 180]);
}
{
  const a = attributeFee(fee({ amount: 500, charge: charge({ kind: 'party_booking' }) }));
  t('party -> parties bucket', a.bucket, 'parties');
}
{
  // pre-2026-09-09 charges put `kind` on the Session, which never reaches the Charge
  const a = attributeFee(fee({ amount: 900, charge: charge({}) }));
  t('no kind -> uncategorized, not dues', [a.bucket, a.bucketCents], ['uncategorized', 900]);
}
{
  const a = attributeFee(fee({ amount: 900, charge: null }));
  t('no charge at all -> uncategorized', a.bucket, 'uncategorized');
}

console.log('— refunds come off, never counted as revenue —');
{
  const a = attributeFee(fee({ amount: 600, amount_refunded: 600, charge: charge({ kind: 'application' }) }));
  t('fully refunded -> nothing kept', [a.netCents, a.bucketCents], [0, 0]);
}
{
  const a = attributeFee(fee({ amount: 600, amount_refunded: 150, charge: charge({ kind: 'application' }) }));
  t('partially refunded -> net only', [a.netCents, a.bucketCents], [450, 450]);
}
{
  const a = attributeFee(fee({ amount: 600, amount_refunded: 999, charge: charge({ kind: 'application' }) }));
  t('over-refund cannot go negative', a.netCents, 0);
}

console.log('— the plan fee is split back out of the bundled amount —');
{
  // $600 dues on a 4-payment plan: 1% = $6 dues cut + $16 plan fee = $22 total
  const a = attributeFee(fee({ amount: 2200, charge: charge({ kind: 'payment_plan_first', fee_plan_cents: '1600' }) }));
  t('unrefunded split', [a.bucket, a.bucketCents, a.planFeeCents], ['dues', 600, 1600]);
  t('split sums to net', a.bucketCents + a.planFeeCents, a.netCents);
}
{
  // half refunded: we keep half of each portion, and neither may go negative
  const a = attributeFee(fee({ amount: 2200, amount_refunded: 1100, charge: charge({ kind: 'payment_plan_first', fee_plan_cents: '1600' }) }));
  t('half-refunded split', [a.bucketCents, a.planFeeCents], [300, 800]);
  t('still sums to net', a.bucketCents + a.planFeeCents, a.netCents);
}
{
  // a plan fee larger than the fee itself must not push dues negative
  const a = attributeFee(fee({ amount: 400, charge: charge({ kind: 'payment_plan_installment', fee_plan_cents: '99999' }) }));
  t('over-large plan fee clamps', [a.bucketCents >= 0, a.bucketCents + a.planFeeCents], [true, a.netCents]);
}
{
  const a = attributeFee(fee({ amount: 0, amount_refunded: 0, charge: charge({ kind: 'application', fee_plan_cents: '0' }) }));
  t('a waived club contributes zero', [a.netCents, a.bucketCents, a.planFeeCents], [0, 0, 0]);
}

console.log('— attribution is by connected account, not metadata —');
{
  const a = attributeFee(fee({ account: 'acct_XYZ', amount: 100, charge: charge({ kind: 'application', tenant_id: 'wrong-on-purpose' }) }));
  t('uses fee.account', a.account, 'acct_XYZ');
}
t('empty bucket set starts at zero', Object.values(emptyBuckets()).every(v => v === 0), true);

// ── referral rewards never exceed the member's own membership ───────────
const DUES = 60000, REWARD = 10000;

console.log('— earning toward a free season —');
t('nothing earned yet',      capState(DUES, 0).remaining_cents, DUES);
t('after two referrals',     capState(DUES, 20000).remaining_cents, 40000);
t('full reward while there is room', grantableReward(capState(DUES, 20000), REWARD), REWARD);
t('five referrals = $500 in', capState(DUES, 50000).remaining_cents, 10000);
t('the sixth makes it free',  grantableReward(capState(DUES, 50000), REWARD), REWARD);

console.log('— and never a penny past it —');
t('at the cap, grants nothing',   grantableReward(capState(DUES, DUES), REWARD), 0);
t('somehow over, still nothing',  grantableReward(capState(DUES, 99999), REWARD), 0);
t('remaining never negative',     capState(DUES, 99999).remaining_cents, 0);

console.log('— partial, so a good referrer is not punished —');
t('$50 of room grants $50', grantableReward(capState(DUES, 55000), REWARD), 5000);
t('$1 of room grants $1',   grantableReward(capState(DUES, 59900), REWARD), 100);
{
  // Six $100 rewards against $600 of dues: exactly covered, never over.
  let awarded = 0;
  for (let i = 0; i < 10; i++) awarded += grantableReward(capState(DUES, awarded), REWARD);
  t('ten referrals still only cover the membership', awarded, DUES);
}

console.log('— a club with no priced tiers —');
t('is uncapped rather than blocked', capState(0, 0).uncapped, true);
t('and still pays the reward',       grantableReward(capState(0, 0), REWARD), REWARD);
t('a cheaper membership caps lower', capState(40000, 40000).remaining_cents, 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

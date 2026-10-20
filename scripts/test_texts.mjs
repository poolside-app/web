#!/usr/bin/env node
// Targeted check for texts (PLAN.md BG2, from the 10/20 audit). Renewal
// texts over the day's limit wait for the next morning instead of being
// skipped, the board is told, and the renewal and board-invite texts are
// plain, one-segment wording. Offline: the builders and the wiring.
//
// Usage: node scripts/test_texts.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BG2 · the renewal text');
let t = null;
try { t = await importTs(new URL('supabase/functions/_shared/sms_text.ts', root)); } catch (e) { check('sms_text.ts loads', false, e.message); }
if (t) {
  const link = 'https://bishopestates.poolsideapp.com/renew.html?t=Ab3dEf6hIj9kLm2nOp5qRs8t';
  const body = t.renewalText ? t.renewalText({ tenantName: 'Bishop Estates Cabana Club', year: 2027, link }) : '';
  check('there is one builder for the renewal text', typeof t.renewalText === 'function');
  check('it says the season and that details are filled in', /renew for 2027/.test(body) && /filled in/.test(body) && body.endsWith(link), body);
  check('no "No login needed… Sign in" contradiction, no "link good 7 days"', !/No login needed/.test(body) && !/7 days/.test(body) && !/Sign in & pay/.test(body), body);
  const m = t.measureSms(body);
  check('plain characters only, one or two segments', m.encoding === 'GSM-7' && m.segments <= 2, JSON.stringify(m));
  const custom = t.renewalText ? t.renewalText({ tenantName: 'Bishop', year: 2027, link, message: 'It’s time — renew “now”…' }) : '';
  check('the board\'s own words are cleaned of curly quotes and long dashes', t.measureSms(custom).encoding === 'GSM-7' && custom.includes("It's time - renew \"now\"..."), custom);
}

console.log('BG2 · over the day\'s limit, texts wait for the morning');
const sendSms = read('supabase/functions/_shared/send_sms.ts');
const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /sms_queue/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('');
check('a queue table for texts', /create table if not exists public\.sms_queue/.test(mig) && /enable row level security/.test(mig), mig ? '' : 'no migration');
check('sendSms can queue a text the daily limit stopped', /queueIfCapped/.test(sendSms) && /from\('sms_queue'\)\.insert/.test(sendSms) && /global_daily/.test(sendSms));
check('the queue is drained by a shared helper', /export async function drainSmsQueue/.test(sendSms));
check('the daily run drains it', /drainSmsQueue\(/.test(read('supabase/functions/payment_plans/index.ts')));
const ren = read('supabase/functions/renewals/index.ts');
check('the renewal message sends through sendSms with queueing on', /sendSms\(\{[\s\S]{0,500}queueIfCapped: true/.test(ren) && /renewalText\(/.test(ren));
check('the answer counts texts waiting for tomorrow', /sms_queued/.test(ren));
check('the Renewals screen says texts will go tomorrow morning', /sms_queued/.test(read('club/admin/members.html')) && /tomorrow morning/.test(read('club/admin/members.html')));

console.log('BG2 · the board invite text');
const tad = read('supabase/functions/tenant_admin_auth/index.ts');
const invite = (tad.match(/const smsBody = `\$\{args\.tenantName\} on Poolside[^`]*`/) || [''])[0];
check('the invite text has no long dash', invite && !/[—–]/.test(invite), invite);

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Targeted check for the email fixes (PLAN.md BG5, from the 10/20 audit):
// replies to club emails reach the club (a Club email on Settings → Club
// info, else the President; Doug 10/20); dates read like dates; the dues
// reminder, the plan reminder and "party time released" are on Settings →
// Emails; the board invite and sign-in emails get the club look. Offline.
//
// Usage: node scripts/test_email_fixes.mjs
import { readFileSync, existsSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
// email_template.ts reads Deno.env through send_email.ts; nothing is sent offline.
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BG5 · dates (item 17)');
let pt = null;
try { pt = await importTs(new URL('supabase/functions/_shared/pool_time.ts', root)); } catch (e) { check('pool_time loads', false, e.message); }
if (pt) {
  check('a pool date reads "Sunday, August 1"', pt.fmtPoolDay && pt.fmtPoolDay('2027-08-01') === 'Sunday, August 1', pt.fmtPoolDay && pt.fmtPoolDay('2027-08-01'));
}
const pp = read('supabase/functions/payment_plans/index.ts');
check('the plan receipt\'s next date is formatted', /next_due_date: next \? fmtPoolDay\(next\.due_date/.test(pp));

console.log('BG5 · replies reach the club (item 16)');
const rt = existsSync(new URL('supabase/functions/_shared/reply_to.ts', root)) ? read('supabase/functions/_shared/reply_to.ts') : '';
check('reply-to is the Club email, else the President', /club\b[\s\S]*email/.test(rt) && /noticeRecipients\(/.test(rt));
const et = read('supabase/functions/_shared/email_template.ts');
check('every registry email gets it', /clubReplyTo\(/.test(et) && /replyTo: args\.replyTo \?\? /.test(et));
const st = read('club/admin/settings.html');
check('Settings → Club info has a Club email box', /id="club_email"/.test(st) && /email:\s+val\('club_email'\)/.test(st));

console.log('BG5 · reminders and notices on Settings → Emails (items 12, 24)');
let reg = null;
try { reg = await importTs(new URL('supabase/functions/_shared/email_template.ts', root)); } catch (e) { check('the registry loads', false, e.message); }
if (reg) {
  const keys = reg.EMAIL_REGISTRY.map(d => d.key);
  for (const k of ['dues_reminder', 'plan_payment_upcoming', 'party_released']) check(`  ${k} is in the list`, keys.includes(k));
  const d = reg.EMAIL_REGISTRY.find(x => x.key === 'dues_reminder');
  if (d) {
    const v = { primary_name: 'Pat', tenant_name: 'Bishop', amount: '$600.00', venmo_link: 'https://venmo.com/x', venmo_code: 'K7Q2', club_url: 'https://b.poolsideapp.com' };
    const waiting = reg.composeEmail('dues_reminder_waiting', null, null, v).html;
    const approved = reg.composeEmail('dues_reminder_approved', null, null, v).html;
    check('a waiting family isn\'t told they\'re approved', !/approved/i.test(waiting.replace(/will approve/i, '')) && /will approve/i.test(waiting), '');
    check('an approved family is told they\'re approved', /is approved/i.test(approved));
    check('both show the amount, the Venmo button and the code', [waiting, approved].every(h => h.includes('$600.00') && h.includes('venmo.com/x') && h.includes('K7Q2')));
  }
}
const apps = read('supabase/functions/applications/index.ts');
const rem = (apps.split("if (action === 'send_reminder')")[1] || '').split("if (action === '")[0];
check('Send reminder uses the list (no hand-built email)', /renderAndSend\(/.test(rem) && /dues_reminder_/.test(rem) && !/api\.resend\.com/.test(rem));
check('the plan reminder uses the list', !/async function sendReminderEmail/.test(pp) && /plan_payment_upcoming/.test(pp));
check('"party time released" uses the list', /party_released/.test(pp) && !/your party time was released`/.test(pp));
const tad = read('supabase/functions/tenant_admin_auth/index.ts');
check('board invite and sign-in emails get the club look (emailShell)', (tad.match(/emailShell\(/g) || []).length >= 2);

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

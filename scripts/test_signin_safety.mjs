#!/usr/bin/env node
// Targeted check for sign-in safety (PLAN.md BG1, from the 10/20 audit).
// A sign-in text or email that can't be sent never puts the code or link on
// screen; wrong board passwords and codes lock after 5 tries; email lookups
// can't be steered by what's typed; sign-in codes don't count toward the
// daily text limit. Offline: the shared rules and the wiring. Costs nothing.
//
// Usage: node scripts/test_signin_safety.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const member = read('supabase/functions/member_auth/index.ts');
const board = read('supabase/functions/tenant_admin_auth/index.ts');
const provider = read('supabase/functions/admin_auth/index.ts');
const tenants = read('supabase/functions/tenants_admin/index.ts');
const apps = read('supabase/functions/applications/index.ts');
const mLogin = read('m/login.html');
const bLogin = read('club/admin/login.html');

console.log('BG1 · a failed send never shows the code or link');
check('member sign-in never returns the link', !/dev_link\s*:/.test(member));
check('board sign-in never returns the code or the link', !/dev_code\s*:/.test(board) && !/dev_link:\s*verifyLink/.test(board));
check('the member sign-in page has no "use the link below" fallback', !/data\.dev_link/.test(mLogin));
check('the board sign-in page has no dev code or dev link fallback', !/data\.dev_code/.test(bLogin) && !/data\.dev_link/.test(bLogin));
check('a text that fails is tried by email (member)', /sendMagicLinkEmail\([^)]*code/s.test(member) && /couldn.t text/i.test(member));
check('a text that fails is tried by email (board)', /sendAdminEmailCode\(/.test(board));
check('when nothing could be sent, people are told to try again', /SEND_FAILED/.test(member) && /SEND_FAILED/.test(board));

console.log('BG1 · guessing is limited');
let g = null;
try { g = await importTs(new URL('supabase/functions/_shared/signin_guard.ts', root)); } catch (e) { check('the rules live in _shared/signin_guard.ts', false, e.message); }
if (g) {
  const now = new Date('2026-10-20T12:00:00Z');
  let s = { failed_logins: 0, locked_until: null };
  for (let i = 1; i <= 4; i++) { s = g.afterFailure(s, now); }
  check('4 wrong tries: not locked yet', s.failed_logins === 4 && !s.locked_until && !g.isLocked(s, now));
  s = g.afterFailure(s, now);
  check('the 5th wrong try locks for 15 minutes', g.isLocked(s, now) && s.just_locked === true
    && new Date(s.locked_until).getTime() - now.getTime() === 15 * 60_000, JSON.stringify(s));
  check('still locked 14 minutes later', g.isLocked(s, new Date(now.getTime() + 14 * 60_000)));
  check('open again after 15 minutes', !g.isLocked(s, new Date(now.getTime() + 15 * 60_000 + 1)));
  check('the lock message says how long', /15 minutes/.test(g.lockedMessage(s, now)), g.lockedMessage(s, now));
  check('a wildcard in a typed email is taken literally', g.escapeLike('a%b_c\\d') === 'a\\%b\\_c\\\\d', g.escapeLike('a%b_c\\d'));
  check('a * in a typed email can\'t match everyone', !g.escapeLike('*@gmail.com').includes('*') && !g.escapeLike('*@gmail.com').includes('%'));
}
check('board password login checks and records the lock', /isLocked\(/.test(board) && /afterFailure\(/.test(board) && /locked_until/.test(board));
check('provider password login checks and records the lock', /isLocked\(/.test(provider) && /afterFailure\(/.test(provider));
check('wrong board codes are counted, like members\'', /code_attempts/.test(board));
check('a lock emails the person', /lockedEmail\(/.test(board) && /lockedEmail\(/.test(provider));
const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /signin_guard/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('');
check('the database keeps the counts', /admin_users add column if not exists failed_logins/.test(mig)
  && /provider_admins add column if not exists failed_logins/.test(mig)
  && /admin_magic_links add column if not exists code_attempts/.test(mig), mig ? '' : 'no migration');

console.log('BG1 · lookups');
check('no typed email is pasted into an or() filter', !/\.or\(`email\.eq\.\$\{/.test(board) && !/\.or\(`email\.eq\.\$\{/.test(tenants));
const ilikes = [member, board, apps].map(src => [...src.matchAll(/\.ilike\('email',\s*([^)]+)\)/g)].map(m => m[1].trim()));
check('every email ilike escapes wildcards', ilikes.flat().length > 0 && ilikes.flat().every(a => /^escapeLike\(/.test(a)), JSON.stringify(ilikes));

console.log('BG1 · sign-in codes skip the daily text limit');
check('member codes skip the daily limit (per-phone limit stays)', /checkGlobalSmsKillSwitch\(args\.sb, args\.to, \{ skipDailyCap: true \}\)/.test(member));
check('board codes skip the daily limit (per-phone limit stays)', /async function sendAdminSmsCode[\s\S]{0,600}checkGlobalSmsKillSwitch\(args\.sb, args\.to, \{ skipDailyCap: true \}\)/.test(board));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

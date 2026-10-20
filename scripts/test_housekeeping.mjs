#!/usr/bin/env node
// Targeted check for the housekeeping fixes (PLAN.md BG8, from the 10/20
// audit): no real people's names or Doug's phone number in the repo's files;
// the free tests run on every push; a no-signal page; protective headers;
// the scheduled calls' 30-second wait. Offline.
//
// Usage: node scripts/test_housekeeping.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

console.log('BG8 · personal details out of the repo (item 3)');
let files = [];
try { files = execSync('git ls-files -z', { cwd: new URL('.', root).pathname, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { /* not a git checkout */ }
// Doug's own provider login is seeded with his address on purpose.
const allowed = new Set(['supabase/migrations/20260428000200_seed_doug_provider_admin.sql', 'supabase/functions/stripe_webhook/index.ts',
  'scripts/test_housekeeping.mjs']);   // this file names what it looks for
const hits = [];
for (const f of files) {
  if (allowed.has(f) || f.startsWith('handouts/') || /\.(png|jpg|jpeg|mp4|ico|pdf)$/i.test(f) || !existsSync(new URL(f, root))) continue;
  const s = read(f);
  if (/\b(Kristin|Beaubien|Lemieux)\b|771-9074|7719074|doug\.frevele@gmail\.com/.test(s)) hits.push(f);
}
check('no real names, Doug\'s mobile or his Gmail in the files', files.length > 0 && hits.length === 0, hits.join(', ') || (files.length ? '' : 'git ls-files found nothing'));

console.log('BG8 · the free tests run on every push (item 37)');
const wf = existsSync(new URL('.github/workflows/offline-tests.yml', root)) ? read('.github/workflows/offline-tests.yml') : '';
check('a workflow runs on each push to main', /on:\s*\n\s*push:\s*\n\s*branches: \[main\]/.test(wf));
for (const t of ['test_money', 'test_signin_safety', 'test_texts', 'test_money_fixes', 'test_signup_fixes', 'test_email_fixes', 'test_screen_fixes', 'test_site_fixes', 'test_housekeeping']) {
  check(`  it runs ${t}`, new RegExp(`\\b${t}\\b`).test(wf));
}
check('the suites that need secrets run without them offline', ['test_agenda', 'test_board_meetings', 'test_help_requests', 'test_money', 'test_positions', 'test_screens']
  .every(t => /try \{ return read\('\.env\.local'\); \} catch \{ return ''; \}/.test(read(`scripts/${t}.mjs`))));

console.log('BG8 · no signal at the pool (item 38)');
const sw = read('sw.js');
check('a no-signal page', existsSync(new URL('offline.html', root)) && /keyfob still works/.test(read('offline.html')));
check('the app keeps it and shows it when a page can\'t load', /OFFLINE_URL = '\/offline\.html'/.test(sw) && /mode !== 'navigate'/.test(sw) && /caches\.match\(OFFLINE_URL\)/.test(sw));
check('a pop-up tap reuses the open app', /\.navigate\(target\)/.test(sw));

console.log('BG8 · protective headers (item 39)');
let vj = {};
try { vj = JSON.parse(read('vercel.json')); } catch { /* checked below */ }
const hdrs = (vj.headers || []).flatMap(h => h.headers || []).map(h => h.key);
check('frame, https, referrer and sniffing headers on every page', ['X-Frame-Options', 'Content-Security-Policy', 'Strict-Transport-Security', 'Referrer-Policy', 'X-Content-Type-Options'].every(k => hdrs.includes(k)), hdrs.join(','));
check('the routing is untouched (9 rewrites)', Array.isArray(vj.rewrites) && vj.rewrites.length === 9);

console.log('BG8 · scheduled calls (item 42)');
check('they wait 30 seconds', /timeout_milliseconds := 30000/.test(read('supabase/migrations/20261020000700_cron_timeouts.sql')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

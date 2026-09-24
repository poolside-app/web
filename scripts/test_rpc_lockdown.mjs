#!/usr/bin/env node
// PLAN.md B1: nobody holding the public key (it ships in every page) can run
// database functions directly — only the server and the scheduler can.
//
// Safe to run against production:
//   • the credit functions are probed with a made-up club id, so even an open
//     door spends nothing;
//   • the scheduled jobs are only called from outside once the database says
//     outsiders can't run them, so a probe can never start a real job.
// No Edge Function calls. Waits up to ~6 minutes for the scheduler to prove it
// still runs after the lock.
//
// Usage: node scripts/test_rpc_lockdown.mjs
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY } = env;

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 200) : ''}`); }
  return ok;
}
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-rpc/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
// A direct database call over the public REST API, as a stranger (public key)
// or as the server (secret key).
async function rpc(fn, args, key) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: key, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  return { status: r.status, body: (await r.text()).slice(0, 200) };
}
const denied = r => r.status === 401 || r.status === 403 || /permission denied/i.test(r.body);

const NOBODY = randomUUID();   // not a club — spending "its" credits changes nothing
const JOBS = ['run_applications_cleanup_cron', 'run_auto_renew_cron', 'run_external_calendar_cron',
  'run_gate_bridge_monitor_cron', 'run_payment_plans_cron'];
const startedAt = new Date().toISOString();

console.log('A stranger with the public key');
for (const [fn, args] of [['consume_sms_credits', { p_tenant: NOBODY, p_n: 1 }], ['consume_sms_credit', { p_tenant: NOBODY }]]) {
  const r = await rpc(fn, args, SUPABASE_PUBLISHABLE_KEY);
  check(`can't spend a club's text credits (${fn})`, denied(r), `HTTP ${r.status} ${r.body}`);
}
for (const fn of JOBS) {
  const [{ anon, signed_in }] = await sql(`select has_function_privilege('anon', 'public.${fn}()', 'EXECUTE') as anon,
    has_function_privilege('authenticated', 'public.${fn}()', 'EXECUTE') as signed_in`);
  if (anon || signed_in) { check(`can't start the ${fn.replace(/^run_|_cron$/g, '')} job`, false, 'the database still lets outsiders run it'); continue; }
  const r = await rpc(fn, {}, SUPABASE_PUBLISHABLE_KEY);
  check(`can't start the ${fn.replace(/^run_|_cron$/g, '')} job`, denied(r), `HTTP ${r.status} ${r.body}`);
}
const open = await sql(`select string_agg(p.proname, ', ') as names from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prokind = 'f'
    and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))`);
check('no function in the app\'s schema is open to outsiders', !open[0].names, open[0].names);
await sql(`create or replace function public.zz_lockdown_probe() returns int language sql as 'select 1'`);
try {
  const [{ anon }] = await sql(`select has_function_privilege('anon', 'public.zz_lockdown_probe()', 'EXECUTE') as anon`);
  check('a function added later starts out private', anon === false, `anon can run it: ${anon}`);
} finally { await sql(`drop function if exists public.zz_lockdown_probe()`); }

console.log('\nThe server and the scheduler still can');
const srv = await rpc('consume_sms_credits', { p_tenant: NOBODY, p_n: 1 }, SUPABASE_SECRET_KEY);
check('the server can still spend text credits (how every text is paid for)', srv.status === 200, `HTTP ${srv.status} ${srv.body}`);
if (failed) {
  console.log('  (skipping the scheduler wait — the lock itself isn\'t in place)');
} else {
  process.stdout.write('  waiting for the next scheduled run');
  let ran = null;
  for (let i = 0; i < 40 && !ran; i++) {
    const rows = await sql(`select j.jobname, d.status from cron.job_run_details d join cron.job j using (jobid)
      where d.start_time > '${startedAt}' and d.status in ('succeeded', 'failed') order by d.start_time limit 1`);
    if (rows.length) ran = rows[0]; else { process.stdout.write('.'); await new Promise(r => setTimeout(r, 10_000)); }
  }
  console.log('');
  check(`the scheduler still runs its jobs${ran ? ` (${ran.jobname}: ${ran.status})` : ''}`, ran?.status === 'succeeded', ran ? ran.status : 'no run within ~6 minutes');
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

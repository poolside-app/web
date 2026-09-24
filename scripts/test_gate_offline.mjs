#!/usr/bin/env node
// Targeted check: when the gate bridge is offline, the member app must say so
// instead of offering an "Unlock the gate" button that can't work.
// About 2 Edge Function calls. Never taps unless the bridge is confirmed
// offline, so it cannot open the real gate.
//
// Usage: node scripts/test_gate_offline.mjs
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';

// web/package.json says "commonjs", so a plain import() of a .ts file fails.
async function importTs(relPath) {
  const js = stripTypeScriptTypes(readFileSync(new URL(relPath, import.meta.url), 'utf8'), { mode: 'strip' });
  return import('data:text/javascript,' + encodeURIComponent(js));
}

const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-gate/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const b64url = b => Buffer.from(b).toString('base64url');
function memberJwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...p, kind: 'member', exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
}
async function gate(action, token) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/unlock_gate`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

console.log('Freshness rule (offline, no calls)');
try {
  const { bridgeOnline } = await importTs('../supabase/functions/_shared/bridge_health.ts');
  const now = Date.parse('2026-09-24T12:00:00Z');
  const ago = s => new Date(now - s * 1000).toISOString();
  check('seen 10s ago → online', bridgeOnline(ago(10), now) === true);
  check('seen 4m59s ago → online', bridgeOnline(ago(299), now) === true);
  check('seen 5m01s ago → offline', bridgeOnline(ago(301), now) === false);
  check('never seen → offline', bridgeOnline(null, now) === false);
} catch (e) {
  check('bridge_health.ts exists', false, e.message.split('\n')[0]);
}

console.log('\nLive, bishopestates');
const [m] = await sql(`select m.id, m.household_id, t.id as tid, t.slug, g.bridge_last_seen_at
  from household_members m join households h on h.id = m.household_id
  join tenants t on t.id = h.tenant_id join gate_panels g on g.tenant_id = t.id
  where t.slug = 'bishopestates' and h.family_name like 'SimTest%' and m.role = 'primary'
    and m.active and m.can_unlock_gate and h.active and h.dues_paid_for_year
  order by h.created_at limit 1`);
if (!m) { console.log('  no eligible SimTest member found'); process.exit(2); }
const offlineSecs = m.bridge_last_seen_at ? (Date.now() - Date.parse(m.bridge_last_seen_at)) / 1000 : Infinity;
if (offlineSecs < 600) {
  console.log('  Bridge was seen in the last 10 minutes — refusing to run, a tap could open the real gate.');
  process.exit(2);
}
const token = memberJwt({ sub: m.id, tid: m.tid, slug: m.slug, hid: m.household_id });
const c = await gate('check', token);
if (check('check says the gate is offline', c.ok && c.can_unlock === false && c.reason === 'gate_offline',
  JSON.stringify(c).slice(0, 160))) {
  const t = await gate('tap', token);
  check('a tap is refused with the offline reason', t.status === 403 && t.reason === 'gate_offline',
    JSON.stringify(t).slice(0, 160));
  const [{ n }] = await sql(`select count(*)::int as n from gate_unlocks
    where member_id = '${m.id}' and requested_at > now() - interval '2 minutes'`);
  check('no unlock was queued', n === 0, `queued=${n}`);
} else {
  console.log('  (tap skipped — it would queue a real unlock)');
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

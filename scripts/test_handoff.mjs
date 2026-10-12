#!/usr/bin/env node
// Targeted check for carrying both sign-ins into a newly added Home Screen
// app (PLAN.md AI). Offline by default; `--live` asks for a board handoff as
// Bishop's owner, uses it once and checks it can't be used twice (3 calls).
//
// Usage: node scripts/test_handoff.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 260);

console.log('AI1 · both sign-ins ride along (offline)');
let ho = '';
try { ho = read('js/handoff.js'); } catch (e) { check('the shared script js/handoff.js', false, e.message); }
check('it writes the manifest link with both one-time sign-ins (h, ah)', /param: 'h'/.test(ho) && /param: 'ah'/.test(ho) && /function manifestHref/.test(ho) && /document\.write/.test(ho) && /addManifestLink/.test(ho));
check('it gets them for whichever sign-ins this phone has', /prepare/.test(ho) && /action: 'handoff'/.test(ho) && /tenant_admin_auth/.test(ho) && /member_auth/.test(ho));
check('only on an iPhone that hasn\'t added the app', /iPad\|iPhone\|iPod/.test(ho) && /standalone/.test(ho));
const mh = read('m/index.html'), bh = read('club/admin/index.html');
const head = s => s.slice(0, s.indexOf('</head>'));
check('the member home and the board home load it in <head>, with no other manifest link first', /<script src="\/js\/handoff\.js"><\/script>/.test(head(mh)) && /<script src="\/js\/handoff\.js"><\/script>/.test(head(bh)) && !/<link rel="manifest"/.test(head(bh)));
const tat = read('supabase/functions/tenant_admin_auth/index.ts');
const hand = tat.slice(tat.indexOf("action === 'handoff'"), tat.indexOf("action === 'handoff'") + 1200);
check('the board handoff lasts an hour, once only, and never for a provider visit', tat.includes("action === 'handoff'") && /60 \* 60 \* 1000/.test(hand) && /admin_magic_links/.test(hand) && /synthetic|impersonated_by/.test(hand));
const mf = read('supabase/functions/tenant_manifest/index.ts');
check('the manifest\'s start carries both', /searchParams\.get\('ah'\)/.test(mf) && /ah=/.test(mf));

console.log('AI2 · the new app signs itself in (offline)');
check('it exchanges both when the added app first opens', /consume/.test(ho) && /verify_link/.test(ho) && /action: 'verify'/.test(ho));
check('a sign-in in a shared link is cleaned off and not used in a browser tab', /own/.test(ho) && /replaceState/.test(ho));
check('the member home and board home use it before anything else', /await PoolsideHandoff\.consume\(\)/.test(mh) && /await PoolsideHandoff\.consume\(\)/.test(bh) && bh.indexOf('await PoolsideHandoff.consume()') < bh.indexOf('PoolsideAuth.meOrLogout()'));

if (LIVE) {
  console.log('\nLive (Bishop owner)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async q => (await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-ai/1.0' }, body: JSON.stringify({ query: q }) })).json();
  const b64 = b => Buffer.from(b).toString('base64url');
  const jwt = p => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 900 })); return `${h}.${body}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`; };
  const fn = async (name, body, token) => { const r = await fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }); return { status: r.status, ...(await r.json().catch(() => ({}))) }; };
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const h = await fn('tenant_admin_auth', { action: 'handoff' }, jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' }));
  const mins = h.expires_at ? Math.round((Date.parse(h.expires_at) - Date.now()) / 60000) : null;
  check('a board handoff, good for about an hour', h.ok && !!h.token && mins >= 55 && mins <= 61, short({ ok: h.ok, mins }));
  const v1 = await fn('tenant_admin_auth', { action: 'verify_link', slug: 'bishopestates', token: h.token });
  check('the new app trades it for a board sign-in', v1.ok && !!v1.token, short({ ok: v1.ok, error: v1.error }));
  const v2 = await fn('tenant_admin_auth', { action: 'verify_link', slug: 'bishopestates', token: h.token });
  check('and it can\'t be used twice', !v2.ok, short(v2));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

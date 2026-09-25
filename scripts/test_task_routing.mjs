#!/usr/bin/env node
// Targeted check for dashboard tasks aimed at one board member (PLAN.md E1).
//   - A task can name one board member. Only that person and the president
//     see it, and only that person gets the phone pop-up.
//   - Every alert is tagged with permissions that exist, so it reaches the
//     board members who hold them (not just the president).
// Offline checks cost nothing. The live part is 4 Edge Function calls and
// uses two temporary board logins that can't sign in, removed at the end.
//
// Usage: node scripts/test_task_routing.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { makeTempAdmin, purgeTempAdmins } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');

// web/package.json says "commonjs", so a plain import() of a .ts file fails.
async function importTs(relPath) {
  const js = stripTypeScriptTypes(read(relPath), { mode: 'strip' });
  return import('data:text/javascript,' + encodeURIComponent(js));
}

const env = Object.fromEntries(read('.env.local')
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
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-tasks/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const b64url = b => Buffer.from(b).toString('base64url');
function adminJwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...p, kind: 'tenant_admin', exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
}
async function tasks(action, token, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/admin_tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// ── Offline ─────────────────────────────────────────────────────────────
console.log('Who sees a task, and who gets the pop-up (offline, no calls)');
try {
  const { taskVisibleTo, pushRecipients } = await importTs('supabase/functions/_shared/task_routing.ts');
  const owner = { id: 'own', isOwner: true, scopes: [] };
  const kris  = { id: 'kri', isOwner: false, scopes: ['households', 'events'] };
  const fob   = { id: 'fob', isOwner: false, scopes: ['events'] };
  const forFob = { target_scopes: ['events'], assigned_admin_id: 'fob' };
  check('the assigned board member sees it', taskVisibleTo(forFob, fob) === true);
  check('the president sees it', taskVisibleTo(forFob, owner) === true);
  check('someone else with the same permission does not', taskVisibleTo(forFob, kris) === false);
  check('an unassigned task still goes by permission', taskVisibleTo({ target_scopes: ['households'] }, kris) === true
    && taskVisibleTo({ target_scopes: ['households'] }, fob) === false);
  check('an untagged task is the president\'s only', taskVisibleTo({ target_scopes: [] }, kris) === false
    && taskVisibleTo({ target_scopes: [] }, owner) === true);

  const admins = [
    { id: 'own', role_template: 'owner', scopes: [], active: true },
    { id: 'kri', role_template: 'custom', scopes: ['households', 'events'], active: true },
    { id: 'fob', role_template: 'custom', scopes: ['events'], active: true },
    { id: 'old', role_template: 'custom', scopes: ['events'], active: false },
  ];
  const ids = a => [...a].sort().join(',');
  check('an assigned task pops up only for that person',
    ids(pushRecipients(admins, { scopes: ['events'], assigned_admin_id: 'fob' })) === 'fob',
    ids(pushRecipients(admins, { scopes: ['events'], assigned_admin_id: 'fob' })));
  check('assigned to someone who left → the president instead',
    ids(pushRecipients(admins, { scopes: ['events'], assigned_admin_id: 'old' })) === 'own');
  check('unassigned → everyone with the permission, plus the president',
    ids(pushRecipients(admins, { scopes: ['events'] })) === 'fob,kri,own');
  check('untagged → the president only (these never popped up before)',
    ids(pushRecipients(admins, { scopes: [] })) === 'own');
} catch (e) {
  check('_shared/task_routing.ts exists', false, e.message.split('\n')[0]);
}

console.log('\nEvery alert uses permissions that exist (offline)');
{
  const auth = read('supabase/functions/tenant_admin_auth/index.ts');
  const all = new Set([...auth.match(/const ALL_SCOPES = \[([\s\S]*?)\];/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
  const bad = [], untagged = [];
  const walk = dir => readdirSync(dir).flatMap(n => {
    const p = `${dir}/${n}`;
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });
  const fnDir = new URL('supabase/functions', root).pathname;
  for (const file of walk(fnDir)) {
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(fnDir.length + 1);
    // Tasks (target_scopes) and direct pop-ups to push_admin (scopes).
    for (const m of src.matchAll(/\b(?:target_)?scopes:\s*\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/'([^']+)'/g)) if (!all.has(s[1])) bad.push(`${rel}: '${s[1]}'`);
    }
    for (const m of src.matchAll(/from\('admin_tasks'\)\.insert\(\{/g)) {
      const block = src.slice(m.index, m.index + 500);
      if (!/target_scopes|assigned_admin_id/.test(block)) untagged.push(`${rel}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  check('no alert is tagged with a permission nobody can have', !bad.length, bad.join(', '));
  check('every alert says who it is for', !untagged.length, untagged.join(', '));
  const gate = read('supabase/functions/gate_admin/index.ts');
  const offline = gate.slice(gate.indexOf("kind: 'gate.bridge_offline'") - 400, gate.indexOf("kind: 'gate.bridge_offline'"));
  check('gate-offline alerts go to the keyfob person', /topicOwnerId\([^)]*'keyfob'\)/.test(gate) && /assigned_admin_id/.test(offline));
  check('pop-ups and the dashboard use the tested rules',
    /from '\.\.\/_shared\/task_routing\.ts'/.test(read('supabase/functions/push_admin/index.ts'))
    && /from '\.\.\/_shared\/task_routing\.ts'/.test(read('supabase/functions/admin_tasks/index.ts'))
    && /assigned_admin_id/.test(read('supabase/functions/_shared/enqueue_task.ts')));
}

// ── Live ────────────────────────────────────────────────────────────────
console.log('\nLive, bishopestates');
const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
const [{ n: hasCol }] = await sql(`select count(*)::int as n from information_schema.columns
  where table_schema = 'public' and table_name = 'admin_tasks' and column_name = 'assigned_admin_id'`);
if (!check('admin_tasks can name one board member', hasCol === 1)) {
  console.log('  (live checks skipped until the migration is applied)');
} else {
  try {
    const fobId  = await makeTempAdmin(sql, club.id, 'Keyfob', ['events']);
    const partId = await makeTempAdmin(sql, club.id, 'Parties', ['events']);
    const [t] = await sql(`insert into admin_tasks (tenant_id, target_scopes, kind, summary, assigned_admin_id)
      values ('${club.id}', array['events'], 'simtest.assigned', 'SimTest: fob not working', '${fobId}') returning id`);
    const fobTok  = adminJwt({ sub: fobId, tid: club.id });
    const partTok = adminJwt({ sub: partId, tid: club.id });

    const a = await tasks('list', fobTok);
    const mine = (a.tasks || []).find(x => x.id === t.id);
    check('the keyfob person sees it on their dashboard', !!mine, JSON.stringify(a).slice(0, 160));
    check('…marked as theirs', mine?.assigned_admin_id === fobId && mine?.assigned_name === 'SimTest Keyfob',
      JSON.stringify(mine ?? {}).slice(0, 200));
    const b = await tasks('list', partTok);
    check('the party person, with the same permission, does not', b.ok && !(b.tasks || []).some(x => x.id === t.id),
      JSON.stringify(b).slice(0, 160));
    const c = await tasks('complete', partTok, { id: t.id });
    check('…and can\'t close it', c.status === 403, JSON.stringify(c).slice(0, 160));
    const d = await tasks('complete', fobTok, { id: t.id });
    const [row] = await sql(`select completed_by from admin_tasks where id = '${t.id}'`);
    check('the keyfob person can close it', d.ok && row.completed_by === fobId, JSON.stringify(d).slice(0, 160));
  } finally {
    await purgeTempAdmins(sql, club.id);
  }
  const [{ n: left }] = await sql(`select count(*)::int as n from admin_users
    where tenant_id = '${club.id}' and username like 'simtest-%'`);
  check('temporary board logins removed', left === 0, `left=${left}`);
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

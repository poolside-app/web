#!/usr/bin/env node
// Targeted check for meeting agendas built from one-liners (PLAN.md L).
// Offline checks cost nothing. The live part runs against Bishop with
// temporary board logins and meetings it removes afterward.
//
// Usage: node scripts/test_agenda.mjs [--offline]   (ONLY=L1,L2 limits the live part)
import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const exists = rel => existsSync(new URL(rel, root));
const between = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, to ? src.indexOf(to, i + from.length) : undefined); };
const OFFLINE = process.argv.includes('--offline');
const ONLY = (process.env.ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
const live = step => !OFFLINE && (!ONLY.length || ONLY.includes(step));

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const short = o => String(JSON.stringify(o)).slice(0, 260);
const env = Object.fromEntries(read('.env.local')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-agenda/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const b64url = b => Buffer.from(b).toString('base64url');
function jwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 600 }));
  return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
}
async function fn(name, action, token, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}

// ── L1: one-liners for the next meeting (offline) ───────────────────────
console.log('L1 · one-liners for the next meeting (offline)');
let A = null;
try { A = await importTs(new URL('supabase/functions/_shared/agenda.ts', root)); }
catch (e) { check('L1: the agenda rules exist', false, e.message.split('\n')[0]); }
if (A) {
  check('L1: an item is one line: extra spaces and line breaks become single spaces',
    A.cleanItem('  Bathrooms   have been\ncomplained about  ') === 'Bathrooms have been complained about', A.cleanItem('  Bathrooms   have been\ncomplained about  '));
  check('L1: up to 100 characters; longer is refused with a reason, empty too',
    A.itemProblem('x'.repeat(100)) === null && /100 characters/.test(A.itemProblem('x'.repeat(101)) || '') && /Write/.test(A.itemProblem('   ') || ''), '');
}
{
  const mig = exists('supabase/migrations/20261006000100_meeting_agenda.sql') ? read('supabase/migrations/20261006000100_meeting_agenda.sql') : '';
  check('L1: items are stored with who added them, 100 characters at most, one line',
    /create table if not exists public\.agenda_items/.test(mig) && /length\(body\) between 1 and 100/.test(mig) && /added_by_name/.test(mig), 'no migration');
  const bm = read('supabase/functions/board_meetings/index.ts');
  check('L1: the board can add, change and remove items, and see the list',
    ['next', 'add_item', 'update_item', 'delete_item'].every(a => bm.includes(`action === '${a}'`)), '');
  const page = read('club/admin/board-meetings.html');
  check('L1: the Board minutes page has the "Next meeting" card: one-line box with a counter, and the list',
    /id="next-card"/.test(page) && /maxlength="100"/.test(page) && /id="item-count"/.test(page) && /add_item/.test(page), '');
  check('L1: the dashboard\'s Board meeting card links straight to adding an item', /board-meetings\.html#add/.test(read('club/admin/index.html')), '');
}

const club = OFFLINE ? null : (await sql(`select id from tenants where slug = 'bishopestates'`))[0];
const owner = OFFLINE ? null : (await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`))[0];
const STAMP = String(Date.now()).slice(-6);
const tag = `[t${STAMP}]`;
const tok = id => jwt({ sub: id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
async function cleanup() {
  await sql(`delete from agenda_items where tenant_id = '${club.id}' and body like '%${tag}%'`);
  await sql(`delete from board_meetings where tenant_id = '${club.id}' and title like 'SimTest%'`);
  const { purgeTempAdmins } = await import('./lib/testdata.mjs');
  await purgeTempAdmins(sql, club.id);
}

if (live('L1')) {
  console.log('\nL1 · live (about 8 calls; temporary board logins and items, removed afterward)');
  const { makeTempAdmin } = await import('./lib/testdata.mjs');
  try {
    const a = await makeTempAdmin(sql, club.id, 'L1 Adder', [], 'custom');
    const b = await makeTempAdmin(sql, club.id, 'L1 Other', [], 'custom');
    const add = await fn('board_meetings', 'add_item', tok(a), { body: `  Bathrooms   have been\ncomplained about ${tag} ` });
    check('L1: any board member adds a one-liner; it\'s saved as one line, with their name',
      add.ok && add.item?.body === `Bathrooms have been complained about ${tag}` && /SimTest L1 Adder/.test(add.item?.added_by_name || ''), short(add));
    const long = await fn('board_meetings', 'add_item', tok(a), { body: 'x'.repeat(101) });
    check('L1: more than 100 characters is refused', long.status === 400 && /100 characters/.test(long.error || ''), short(long));
    const notMine = await fn('board_meetings', 'delete_item', tok(b), { id: add.item?.id });
    check('L1: someone else can\'t remove it', notMine.status === 403, short(notMine));
    const bAdd = await fn('board_meetings', 'add_item', tok(b), { body: `Pump quote ${tag}` });
    const list = await fn('board_meetings', 'next', tok(b));
    const mine = (list.items || []).filter(x => x.body.includes(tag));
    check('L1: the list shows everything waiting, who added it, and what each person can change',
      list.ok && mine.length === 2 && mine.find(x => x.id === add.item?.id)?.can_change === false && mine.find(x => x.id === bAdd.item?.id)?.can_change === true, short(mine));
    const edit = await fn('board_meetings', 'update_item', tok(b), { id: bAdd.item?.id, body: `Pump quotes are in ${tag}` });
    const pres = await fn('board_meetings', 'delete_item', jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' }), { id: add.item?.id });
    check('L1: people change their own; the president can remove anyone\'s', edit.ok && edit.item?.body === `Pump quotes are in ${tag}` && pres.ok, short({ edit: edit.error, pres: pres.error }));
  } finally {
    await cleanup();
    const [n] = await sql(`select count(*)::int as n from agenda_items where body like '%${tag}%'`);
    check('L1: test items and logins removed', n.n === 0, short(n));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Targeted check for board meeting minutes (PLAN.md F1–F4).
// F1: any board member can start a meeting in one tap and every board member
// can read all minutes, but only the note-taker and the president can change
// them. Lifeguard / gate-iPad logins are not board members.
// Offline checks cost nothing. The live part is 8 Edge Function calls and
// uses temporary board logins that can't sign in, removed at the end.
//
// Usage: node scripts/test_board_meetings.mjs
import { readFileSync } from 'node:fs';
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
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-meetings/1.0' },
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
async function meetings(action, token, extra = {}) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/board_meetings`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const short = o => JSON.stringify(o).slice(0, 180);

// ── Offline ─────────────────────────────────────────────────────────────
console.log('Who is on the board, and who can change a meeting (offline, no calls)');
try {
  const { isBoardMember, canEditMeeting } = await importTs('supabase/functions/_shared/board.ts');
  check('the president is', isBoardMember({ role_template: 'owner', roles: [], active: true }));
  check('a treasurer or custom board login is', isBoardMember({ role_template: 'treasurer', roles: [], active: true })
    && isBoardMember({ role_template: 'custom', roles: ['membership', 'events'], active: true }));
  check('a lifeguard / gate-iPad login is not', !isBoardMember({ role_template: 'gate_attendant', roles: [], active: true })
    && !isBoardMember({ role_template: 'custom', roles: ['gate_attendant'], active: true }));
  check('a removed board member is not', !isBoardMember({ role_template: 'owner', roles: [], active: false }));
  const m = { created_by: 'kris' };
  check('the note-taker can change their meeting', canEditMeeting(m, { id: 'kris', isOwner: false }));
  check('the president can change any meeting', canEditMeeting(m, { id: 'doug', isOwner: true }));
  check('other board members can only read it', !canEditMeeting(m, { id: 'fob', isOwner: false }));
} catch (e) {
  check('_shared/board.ts exists', false, e.message.split('\n')[0]);
}

console.log('\nEvery board member can find it (offline)');
{
  const page = read('club/admin/board-meetings.html');
  check('one tap starts a meeting', /Start a meeting/.test(page) && /call\('create',\s*\{[^}]*start:\s*true/.test(page));
  check('the meeting shows a running clock', /elapsed|Running/i.test(page) && /setInterval\(/.test(page));
  check('someone else\'s meeting opens read-only', /can_edit/.test(page));
  check('the dashboard has a Start a meeting button', /board-meetings\.html#start/.test(read('club/admin/index.html')));
  check('the Board minutes tab isn\'t hidden by permissions',
    !/meetings:\s*'a\[href="\/club\/admin\/board-meetings\.html"\]'/.test(read('js/admin-flags.js'))
    && !/key: 'meetings',[^}]*scope: 'meetings'/.test(read('js/admin-subtabs.js')));
  check('the server no longer needs the secretary permission',
    !/requireScope\([^)]*'meetings'\)/.test(read('supabase/functions/board_meetings/index.ts')));
}

// ── Live ────────────────────────────────────────────────────────────────
console.log('\nLive, bishopestates');
const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
try {
  const noteId  = await makeTempAdmin(sql, club.id, 'Note', ['events']);
  const otherId = await makeTempAdmin(sql, club.id, 'Other', ['households']);
  const guardId = await makeTempAdmin(sql, club.id, 'Guard', ['check_in'], 'gate_attendant');
  const tok = id => adminJwt({ sub: id, tid: club.id });

  const c = await meetings('create', tok(noteId), { start: true, title: 'SimTest board meeting' });
  const m = c.meeting || {};
  check('a board member without the secretary permission starts one in one tap',
    c.ok && m.status === 'in_progress' && !!m.started_at && m.can_edit === true, short(c));

  const l = await meetings('list', tok(otherId));
  const seen = (l.meetings || []).find(x => x.id === m.id);
  check('another board member can read it, even board-only', !!seen && seen.visibility === 'private', short(l));
  check('…sees who is taking notes, and that it\'s read-only for them',
    seen?.note_taker === 'SimTest Note' && seen?.can_edit === false, short(seen ?? {}));

  const u1 = await meetings('update', tok(otherId), { id: m.id, notes_md: 'not mine' });
  check('…and can\'t change it', u1.status === 403, short(u1));
  const u2 = await meetings('update', tok(noteId), { id: m.id, notes_md: 'Pool opens May 23.' });
  check('the note-taker can', u2.ok && u2.meeting?.notes_md === 'Pool opens May 23.', short(u2));
  const u3 = await meetings('update', tok(owner.id), { id: m.id, notes_md: 'Pool opens May 23. (fixed)' });
  check('the president can', u3.ok, short(u3));

  const g = await meetings('list', tok(guardId));
  check('a lifeguard / gate-iPad login can\'t see minutes', g.status === 403, short(g));
  const a = await meetings('list_active_admins', tok(noteId));
  const names = (a.admins || []).map(x => x.name);
  check('the attendance list has board members but not the lifeguard login',
    names.includes('SimTest Note') && names.includes('SimTest Other') && !names.includes('SimTest Guard'), names.join(', '));
} finally {
  await purgeTempAdmins(sql, club.id);
}
const [{ n: left }] = await sql(`select (select count(*) from admin_users where tenant_id = '${club.id}' and username like 'simtest-%')
  + (select count(*) from board_meetings where tenant_id = '${club.id}' and title like 'SimTest%') as n`);
check('temporary logins and meetings removed', Number(left) === 0, `left=${left}`);

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

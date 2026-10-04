#!/usr/bin/env node
// Targeted check for board positions, alerts by position, and the bylaws
// (PLAN.md K). Offline checks cost nothing. The live part runs against
// Bishop with temporary board logins it removes afterward.
//
// Usage: node scripts/test_positions.mjs [--offline]   (ONLY=K3 limits the live part)
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
const short = o => String(JSON.stringify(o)).slice(0, 240);
const env = Object.fromEntries(read('.env.local')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET } = env;
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-positions/1.0' },
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

// ── K1: positions, and who gets told what (offline) ─────────────────────
console.log('K1 · positions (offline)');
{
  const P = await importTs(new URL('supabase/functions/_shared/positions.ts', root));
  const pos = [
    { id: 'p', slug: 'president', title: 'President', sort: 0, full_access: true, notices: ['help_other'] },
    { id: 'v', slug: 'vice_president', title: 'Vice-President', sort: 1, notices: [] },
    { id: 't', slug: 'treasurer', title: 'Treasurer', sort: 2, notices: ['signups', 'payments'], scopes: ['payments', 'audit'] },
    { id: 'g', slug: 'grounds', title: 'Grounds Director', sort: 5, notices: ['help_grounds'], scopes: [] },
  ];
  const logins = [{ id: 'doug', role_template: 'owner' }, { id: 'tess', role_template: 'custom' }, { id: 'gina', role_template: 'custom' }, { id: 'old', role_template: 'custom', active: false }];
  const holders = [{ position_id: 'p', admin_user_id: 'doug' }, { position_id: 't', admin_user_id: 'tess' }, { position_id: 'v', admin_user_id: 'tess' },
    { position_id: 'g', admin_user_id: 'old' }];
  check('K1: an alert goes to whoever holds the position', short(P.noticeRecipients('payments', pos, holders, logins)) === short(['tess']));
  check('K1: an empty position\'s alerts go to the President', short(P.noticeRecipients('help_grounds', pos, holders, logins)) === short(['doug']),
    short(P.noticeRecipients('help_grounds', pos, holders, logins)));
  check('K1: …then the Vice-President if the President spot is empty',
    short(P.noticeRecipients('help_grounds', pos, holders.filter(h => h.position_id !== 'p'), logins)) === short(['tess']));
  check('K1: …then anyone with full access, so nothing is dropped',
    short(P.noticeRecipients('rentals', pos, [], logins)) === short(['doug']));
  const tess = P.loginFromPositions(pos.filter(p => ['t', 'v'].includes(p.id)));
  check('K1: a person\'s title and screens follow their positions',
    tess.board_title === 'Vice-President · Treasurer' && tess.role_template === 'custom'
      && ['payments', 'audit', 'applications', 'households'].every(s => tess.scopes.includes(s)), short(tess));
  const doug = P.loginFromPositions(pos.filter(p => p.id === 'p'));
  check('K1: the President has full access', doug.role_template === 'owner' && doug.board_title === 'President', short(doug));
  check('K1: the roster for the public page is names and positions',
    short(P.boardRoster(pos, holders, [{ id: 'doug', display_name: 'Doug Frevele', role_template: 'owner' }, { id: 'tess', display_name: 'Tess' }]))
      === short([{ name: 'Doug Frevele', titles: ['President'] }, { name: 'Tess', titles: ['Vice-President', 'Treasurer'] }]));
  check('K1: every task alert and help topic is a real alert, and every screen is real',
    Object.values(P.TASK_NOTICE).every(n => P.NOTICES[n]) && Object.values(P.HELP_NOTICE).every(n => P.NOTICES[n])
      && P.STARTER_POSITIONS.every(p => p.scopes.every(s => P.SCREENS[s]) && p.notices.every(n => P.NOTICES[n])), '');
  const admin = read('supabase/functions/tenant_admin_auth/index.ts');
  const allScopes = between(admin, 'const ALL_SCOPES = [', '];');
  check('K1: every screen is a permission the server knows', Object.keys(P.SCREENS).every(s => allScopes.includes(`'${s}'`)), '');
  check('K1: new clubs start with the seven positions plus Vice-President',
    P.STARTER_POSITIONS.length === 8 && P.STARTER_POSITIONS.filter(p => p.full_access).length === 1
      && !P.STARTER_POSITIONS.some(p => /Bishop|Art\. |2027|170/.test(p.description + p.purpose)), '');
  const signup = read('supabase/functions/tenant_signup/index.ts');
  check('K1: a new club gets the starter positions, with its founder as President',
    /STARTER_POSITIONS/.test(signup) && /board_position_holders/.test(signup) && /spending_rule/.test(signup), 'signup does not seed positions');
  const mig = exists('supabase/migrations/20261004000100_board_positions.sql') ? read('supabase/migrations/20261004000100_board_positions.sql') : '';
  check('K1: Bishop\'s positions are seeded word for word',
    /create table if not exists public\.board_positions/.test(mig) && /Art\. IX §4/.test(mig) && /roughly 170 non-member homes/.test(mig)
      && /30 new or returning families signed up by June 1\. \(2026 had 27\.\)/.test(mig) && /Under \$50, go ahead/.test(mig), 'no migration');
}

if (live('K1')) {
  console.log('\nK1 · live (database reads only)');
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const rows = await sql(`select slug, title, full_access, sort, (select count(*) from board_position_holders h where h.position_id = p.id) holders
    from board_positions p where tenant_id = '${club.id}' order by sort`);
  check('K1: Bishop has its eight positions in order', short(rows.map(r => r.slug)) === short(['president', 'vice_president', 'treasurer', 'secretary', 'facilities', 'grounds', 'membership_marketing', 'events_rentals']), short(rows.map(r => r.slug)));
  const [pres] = await sql(`select a.display_name from board_position_holders h join board_positions p on p.id = h.position_id
    join admin_users a on a.id = h.admin_user_id where p.tenant_id = '${club.id}' and p.slug = 'president'`);
  check('K1: Doug holds President', /Doug/.test(pres?.display_name || ''), short(pres));
  const [{ rule }] = await sql(`select value->'board'->>'spending_rule' as rule from settings where tenant_id = '${club.id}'`);
  check('K1: the spending rule is set', rule === 'Under $50, go ahead. $50 or more needs board approval.', rule);
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

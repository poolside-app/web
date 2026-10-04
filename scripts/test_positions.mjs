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

// ── K2: one Board page (offline) ────────────────────────────────────────
console.log('\nK2 · the Board page (offline)');
{
  const fnSrc = exists('supabase/functions/board/index.ts') ? read('supabase/functions/board/index.ts') : '';
  check('K2: the board function lists positions and lets the president change them',
    ['get', 'save_position', 'delete_position', 'reorder', 'set_holders', 'set_spending_rule'].every(a => fnSrc.includes(`action === '${a}'`))
      && /isOwner/.test(fnSrc), 'missing actions');
  check('K2: changing positions keeps someone with full access', /full access/i.test(between(fnSrc, "action === 'set_holders'", "action === '")) , '');
  const page = exists('club/admin/board.html') ? read('club/admin/board.html') : '';
  check('K2: the Board page has the spending rule, each position, its alerts and job description',
    /id="spending-rule"/.test(page) && /id="positions"/.test(page) && /notices/.test(page) && /description/.test(page), 'no board page');
  check('K2: the president can edit a position, assign holders, and invite someone into it',
    /save_position/.test(page) && /set_holders/.test(page) && /invite_admin/.test(page) && /position_ids/.test(page), '');
  const admins = read('club/admin/admins.html');
  check('K2: the old Admins & roles page sends people to the Board page', /location\.replace\(['"]\/club\/admin\/board\.html/.test(admins) && admins.length < 3000, '');
  const subtabs = read('js/admin-subtabs.js');
  check('K2: Settings shows Board instead of Admins', /label: 'Board',\s*href: '\/club\/admin\/board\.html'/.test(subtabs) && !/admins\.html/.test(subtabs), '');
  const auth = read('supabase/functions/_shared/auth.ts');
  check('K2: a new position applies right away, not after the sign-in token renews',
    /select\('active, role_template, roles, scopes, is_super'\)/.test(between(auth, 'if (jwtComplete) {', '\n  }\n')), 'permissions read from the token');
  const taa = read('supabase/functions/tenant_admin_auth/index.ts');
  check('K2: an invite can put someone straight into a position', /position_ids/.test(between(taa, "action === 'invite_admin'", "action === 'update_admin_title'")), '');
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

if (live('K2')) {
  console.log('\nK2 · live (about 12 calls; temporary board logins, removed afterward)');
  const { makeTempAdmin, purgeTempAdmins } = await import('./lib/testdata.mjs');
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates', role_template: 'owner', scopes: [] });
  const [treas] = await sql(`select id, notices from board_positions where tenant_id = '${club.id}' and slug = 'treasurer'`);
  const started = new Date().toISOString();
  try {
    const got = await fn('board', 'get', ownerTok);
    check('K2: the president sees every position and can edit', got.ok && got.is_owner && got.positions?.length === 8 && Array.isArray(got.staff), short({ ok: got.ok, n: got.positions?.length, err: got.error }));
    const a = await makeTempAdmin(sql, club.id, 'K2 Treasurer', [], 'custom');
    // A token made before they had a position: role and screens inside it are old.
    const aTok = jwt({ sub: a, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates', role_template: 'custom', scopes: [] });
    const before = await fn('payments_admin', 'codes_list', aTok);
    const set = await fn('board', 'set_holders', ownerTok, { position_id: treas.id, admin_ids: [a] });
    const [row] = await sql(`select board_title, role_template, scopes from admin_users where id = '${a}'`);
    check('K2: holding Treasurer gives the title and the Treasurer\'s screens', set.ok && row.board_title === 'Treasurer' && row.scopes.includes('payments') && row.scopes.includes('applications'), short(row));
    const after = await fn('payments_admin', 'codes_list', aTok);
    check('K2: it applies right away, even with their old sign-in token', before.status === 403 && after.ok, short({ before: before.status, after: after.status }));
    const notMine = await fn('board', 'save_position', aTok, { position: { title: 'Sneaky' } });
    check('K2: only the president changes positions', notMine.status === 403, short(notMine));
    const pres = (got.positions || []).find(p => p.slug === 'president');
    const noPres = await fn('board', 'set_holders', ownerTok, { position_id: pres?.id, admin_ids: [] });
    check('K2: the last person with full access can\'t be taken out', noPres.status === 409 && /full access/.test(noPres.error || ''), short(noPres));
    const edit = await fn('board', 'save_position', ownerTok, { position: { id: treas.id, title: 'Treasurer', notices: [...treas.notices, 'rentals'],
      scopes: ['payments', 'applications', 'households', 'renewals', 'tiers', 'audit'], purpose: (got.positions.find(p => p.id === treas.id) || {}).purpose,
      description: (got.positions.find(p => p.id === treas.id) || {}).description } });
    const [row2] = await sql(`select scopes from admin_users where id = '${a}'`);
    check('K2: editing a position updates the people holding it', edit.ok && row2.scopes.includes('parties'), short({ edit: edit.error, scopes: row2.scopes }));
    const made = await fn('board', 'save_position', ownerTok, { position: { title: 'SimTest Pool Captain', purpose: 'Test', notices: ['help_grounds'] } });
    const del = await fn('board', 'delete_position', ownerTok, { id: made.position?.id });
    check('K2: the president can add and remove a position', made.ok && made.position?.slug === 'simtest_pool_captain' && del.ok, short({ made: made.error, del: del.error }));
  } finally {
    await sql(`update board_positions set notices = array[${treas.notices.map(n => `'${n}'`).join(',')}]::text[] where id = '${treas.id}'`);
    await sql(`delete from board_positions where tenant_id = '${club.id}' and slug like 'simtest%'`);
    await sql(`delete from audit_log where tenant_id = '${club.id}' and kind like 'board_position.%' and created_at >= '${started}'`);
    await purgeTempAdmins(sql, club.id);
    const [n] = await sql(`select count(*)::int as n from board_position_holders h join board_positions p on p.id = h.position_id where p.tenant_id = '${club.id}' and p.slug = 'treasurer'`);
    check('K2: Bishop is back as it was', n.n === 0, short(n));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

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

// ── K3: alerts follow positions (offline) ──────────────────────────────
console.log('\nK3 · alerts follow positions (offline)');
{
  const R = await importTs(new URL('supabase/functions/_shared/task_routing.ts', root));
  const treasurer = { id: 'tess', isOwner: false, scopes: ['payments'] };
  const other = { id: 'olly', isOwner: false, scopes: ['payments'] };
  const recipientsOf = n => (n === 'payments' ? ['tess'] : []);
  const task = { kind: 'venmo.claim', target_scopes: ['payments', 'applications'] };
  check('K3: a payments task goes to whoever holds the position that gets it',
    R.taskVisibleTo(task, treasurer, recipientsOf) === true && R.taskVisibleTo(task, other, recipientsOf) === false, '');
  check('K3: the president still sees every task', R.taskVisibleTo(task, { id: 'doug', isOwner: true, scopes: [] }, recipientsOf) === true, '');
  check('K3: an assigned task still goes to that person', R.taskVisibleTo({ kind: 'help.request', assigned_admin_id: 'olly' }, other, recipientsOf) === true, '');
  check('K3: pop-ups for a position\'s alert go only to its holders',
    JSON.stringify(R.pushRecipients([{ id: 'doug', role_template: 'owner' }, { id: 'tess', role_template: 'custom' }], { scopes: ['payments'], notice_recipients: ['tess'] })) === JSON.stringify(['tess']), '');
  check('K3: members can ask about grounds, bathrooms & cleaning', R.HELP_TOPICS.includes('grounds')
    && /grounds: 'Grounds, bathrooms & cleaning'/.test(read('supabase/functions/_shared/help.ts')) && /data-topic="grounds"/.test(read('m/index.html'))
    && exists('supabase/migrations/20261004000200_help_grounds.sql'), '');
  const enq = read('supabase/functions/_shared/enqueue_task.ts');
  check('K3: every new task records its alert and pops up for that position', /TASK_NOTICE/.test(enq) && /notice/.test(between(enq, 'export async function pushBoard', '\n}\n')), '');
  check('K3: the pop-up sender routes by position', /noticeRecipients|recipientsFor/.test(read('supabase/functions/push_admin/index.ts')), '');
  const routing = read('supabase/functions/_shared/task_routing.ts');
  check('K3: member help topics go by position, not a separate setting', /HELP_NOTICE/.test(routing) && !/help_topics/.test(between(routing, 'export async function topicOwnerId', '\n}\n')), '');
  check('K3: gate alerts go to the gate position', !/topicOwnerId\(sb, tenantId, 'keyfob'\)/.test(read('supabase/functions/gate_admin/index.ts')) && /notice: 'gate'/.test(read('supabase/functions/gate_admin/index.ts')), '');
  check('K3: the dashboard list routes by position', /loadBoard/.test(read('supabase/functions/admin_tasks/index.ts')), '');
  const mh = read('club/admin/member-help.html');
  check('K3: Member help shows who handles each topic and links to the Board page', !/saveTopics/.test(mh) && /board\.html/.test(mh), '');
  const hr = read('supabase/functions/help_requests/index.ts');
  check('K3: board replies to members say the board member\'s position',
    /const signedName = myTitle \? `\$\{me\.name\} \(\$\{myTitle\}\)`/.test(hr) && /board_title/.test(between(hr, 'const myTitle', ';')) && /replyText\([^)]*signedName/.test(hr), '');
}

// ── K4: "My job" on the dashboard (offline) ────────────────────────────
console.log('\nK4 · "My job" on the dashboard (offline)');
{
  const at = read('supabase/functions/admin_tasks/index.ts');
  check('K4: the dashboard\'s task list brings the person\'s positions and the spending rule (no extra call)',
    /my_positions/.test(at) && /spending_rule/.test(at), '');
  check('K4: each task says which position it\'s for', /for_position/.test(at), '');
  const dash = read('club/admin/index.html');
  check('K4: the dashboard shows "Your job" with the purpose and full description',
    /id="my-job-card"/.test(dash) && /my_positions/.test(dash) && /description/.test(between(dash, 'function paintMyJob', '\n}\n')), '');
  check('K4: a task names its position ("For the Treasurer")', /for_position/.test(between(dash, 'function taskFor', '\n}\n')), '');
}

// ── K5: the setup checklist (offline) ──────────────────────────────────
console.log('\nK5 · setup checklist (offline)');
{
  const ts = read('supabase/functions/tenant_settings/index.ts');
  const item = between(ts, "{ id: 'invite_board'", "{ id: 'share_link'");
  check('K5: "Set up your board positions" opens the Board page and is done when someone else holds a position',
    /Set up your board positions/.test(item) && /board\.html/.test(item) && /board_position_holders/.test(between(ts, "action === 'setup_status'", '{ id: \'logo\'')), item.slice(0, 160));
}

// ── K6: the bylaws (offline) ───────────────────────────────────────────
console.log('\nK6 · the bylaws (offline)');
{
  const mig = exists('supabase/migrations/20261004000300_club_documents.sql') ? read('supabase/migrations/20261004000300_club_documents.sql') : '';
  check('K6: a place for the bylaws, keeping every version', /create table if not exists public\.club_documents/.test(mig) && /'bylaws'/.test(mig), 'no migration');
  const bm = read('supabase/functions/board_meetings/index.ts');
  check('K6: the President or Secretary sets the bylaws; only a file stored with the club counts',
    /action === 'set_bylaws'/.test(bm) && /policies/.test(between(bm, "action === 'set_bylaws'", 'return jsonResponse({ ok: true')) && /club-assets/.test(bm), '');
  check('K6: the public minutes page gets the bylaws and the board (names and positions)',
    /bylaws/.test(between(bm, "action === 'list_public'", "Admin-only actions below")) && /boardRoster/.test(bm), '');
  const page = read('board-meetings.html'.replace(/^/, 'club/admin/'));
  check('K6: the Board minutes page has the bylaws, with upload', /id="bylaws-card"/.test(page) && /tenant_upload/.test(page) && /set_bylaws/.test(page), '');
  const gov = read('governance.html');
  check('K6: the public page shows the bylaws first, always, and the board', /id="bylaws-host"/.test(gov) && /id="board-host"/.test(gov)
    && gov.indexOf('id="bylaws-host"') < gov.indexOf('id="meetings-host"'), '');
  check('K6: the member app links to the bylaws and minutes', /href="\/governance\.html"/.test(read('m/index.html')), '');
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

if (live('K3')) {
  console.log('\nK3 · live (about 12 calls; temporary family and board logins, removed afterward)');
  const { makeTempAdmin, purgeTempAdmins, makeTempMember, purgeTestFamilies } = await import('./lib/testdata.mjs');
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates', role_template: 'owner', scopes: [] });
  const pos = Object.fromEntries((await sql(`select slug, id from board_positions where tenant_id = '${club.id}'`)).map(r => [r.slug, r.id]));
  const STAMP = String(Date.now()).slice(-6);
  const started = new Date().toISOString();
  let taskId = null;
  try {
    const g = await makeTempAdmin(sql, club.id, 'K3 Grounds', [], 'custom');
    const x = await makeTempAdmin(sql, club.id, 'K3 Money Screen', ['payments'], 'custom');
    const t = await makeTempAdmin(sql, club.id, 'K3 Treasurer', [], 'custom');
    const tok = id => jwt({ sub: id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    await fn('board', 'set_holders', ownerTok, { position_id: pos.grounds, admin_ids: [g] });

    // A member reports a grounds problem: it goes to the Grounds Director.
    const m = await makeTempMember(sql, club.id, `SimPos Family ${STAMP}`);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: m.household_id });
    const ask = await fn('help_requests', 'submit', memTok, { topic: 'grounds', body: 'The women\'s bathroom is out of paper towels. (test)' });
    const [req] = ask.ok ? await sql(`select assigned_admin_id from help_requests where id = '${ask.request?.id}'`) : [null];
    check('K3: a grounds question goes to the Grounds Director', ask.ok && req?.assigned_admin_id === g, short({ err: ask.error, req }));
    const gList = await fn('admin_tasks', 'list', tok(g));
    check('K3: it\'s on the Grounds Director\'s dashboard, and says it\'s theirs', gList.ok && (gList.tasks || []).some(k => k.kind === 'help.request' && k.source_id === ask.request?.id)
      && (gList.help_topics_mine || []).includes('Grounds, bathrooms & cleaning'), short({ n: gList.tasks?.length, mine: gList.help_topics_mine }));
    const topics = await fn('help_requests', 'topics', ownerTok);
    check('K3: Member help shows who handles grounds, by position', topics.ok && topics.topics?.grounds?.admin_id === g && topics.topics?.grounds?.position === 'Grounds Director', short(topics.topics?.grounds));

    // A payments task: the Treasurer's, not everyone who can open Money.
    const [task] = await sql(`insert into admin_tasks (tenant_id, target_scopes, kind, summary, source_kind, source_id)
      values ('${club.id}', array['payments','applications'], 'venmo.claim', 'SimTest K3 Venmo to check', 'simtest', '${club.id}') returning id`);
    taskId = task.id;
    const sees = async id => ((await fn('admin_tasks', 'list', tok(id))).tasks || []).some(k => k.id === taskId);
    const xBefore = await sees(x);
    const dougSees = ((await fn('admin_tasks', 'list', ownerTok)).tasks || []).some(k => k.id === taskId);
    await fn('board', 'set_holders', ownerTok, { position_id: pos.treasurer, admin_ids: [t] });
    const tSees = await sees(t), xAfter = await sees(x);
    check('K3: a payments task goes to the Treasurer, not to everyone with the Money screen', !xBefore && dougSees && tSees && !xAfter,
      short({ xBefore, dougSees, tSees, xAfter }));
  } finally {
    if (taskId) await sql(`delete from admin_tasks where id = '${taskId}'`);
    await sql(`delete from audit_log where tenant_id = '${club.id}' and kind like 'board_position.%' and created_at >= '${started}'`);
    await purgeTestFamilies(sql, club.id, `SimPos Family ${STAMP}`);
    await purgeTempAdmins(sql, club.id);
    const [n] = await sql(`select count(*)::int as n from board_position_holders h join board_positions p on p.id = h.position_id
      where p.tenant_id = '${club.id}' and p.slug in ('grounds', 'treasurer')`);
    check('K3: Bishop is back as it was', n.n === 0, short(n));
  }
}

if (live('K6')) {
  console.log('\nK6 · live (about 8 calls; temporary board logins and test files, removed afterward)');
  const { makeTempAdmin, purgeTempAdmins } = await import('./lib/testdata.mjs');
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates', role_template: 'owner', scopes: [] });
  const [sec] = await sql(`select id from board_positions where tenant_id = '${club.id}' and slug = 'secretary'`);
  const STAMP = String(Date.now()).slice(-6);
  const started = new Date().toISOString();
  const fileUrl = n => `${SUPABASE_URL}/storage/v1/object/public/club-assets/${club.id}/simtest-bylaws-${STAMP}-${n}.pdf`;
  try {
    const s = await makeTempAdmin(sql, club.id, 'K6 Secretary', [], 'custom');
    const n = await makeTempAdmin(sql, club.id, 'K6 Grounds', [], 'custom');
    const tok = id => jwt({ sub: id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    await fn('board', 'set_holders', ownerTok, { position_id: sec.id, admin_ids: [s] });
    const no = await fn('board_meetings', 'set_bylaws', tok(n), { url: fileUrl(1), file_name: 'Bylaws.pdf' });
    check('K6: only the President or Secretary posts the bylaws', no.status === 403, short(no));
    const elsewhere = await fn('board_meetings', 'set_bylaws', tok(s), { url: 'https://example.com/bylaws.pdf' });
    check('K6: only a PDF uploaded to the club counts', elsewhere.status === 400, short(elsewhere));
    const v1 = await fn('board_meetings', 'set_bylaws', tok(s), { url: fileUrl(1), file_name: 'Bishop Bylaws 2025.pdf' });
    const v2 = await fn('board_meetings', 'set_bylaws', tok(s), { url: fileUrl(2), file_name: 'Bishop Bylaws 2026.pdf' });
    check('K6: the Secretary posts the bylaws, and a new version keeps the old', v1.ok && v2.ok, short({ v1: v1.error, v2: v2.error }));
    const pub = await fn('board_meetings', 'list_public', null, { slug: 'bishopestates' });
    check('K6: the public page gets the current bylaws and earlier versions, with no sign-in',
      pub.ok && pub.bylaws?.current?.url === fileUrl(2) && pub.bylaws?.earlier?.some(v => v.url === fileUrl(1)), short(pub.bylaws));
    check('K6: and the board: names and positions only', Array.isArray(pub.board)
      && pub.board.some(m => /Doug/.test(m.name) && m.titles.includes('President')) && pub.board.some(m => m.titles.includes('Secretary'))
      && !JSON.stringify(pub.board).includes('description'), short(pub.board));
  } finally {
    await sql(`delete from club_documents where tenant_id = '${club.id}' and url like '%simtest-bylaws-${STAMP}%'`);
    await sql(`delete from audit_log where tenant_id = '${club.id}' and (kind like 'board_position.%' or kind = 'bylaws.uploaded') and created_at >= '${started}'`);
    await purgeTempAdmins(sql, club.id);
    const [left] = await sql(`select (select count(*) from club_documents where url like '%simtest%')::int as docs,
      (select count(*) from board_position_holders h join board_positions p on p.id = h.position_id where p.tenant_id = '${club.id}' and p.slug = 'secretary')::int as sec`);
    check('K6: Bishop is back as it was', left.docs === 0 && left.sec === 0, short(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

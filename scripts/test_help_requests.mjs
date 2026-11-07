#!/usr/bin/env node
// Targeted check for member help requests (PLAN.md E2–E4).
// E2: a member sends a question from the app. It goes to the board member
// who handles that topic (or the president), stays on their dashboard until
// solved, and board replies are texted to the member. Photos are private.
// Offline checks cost nothing. The live part is about 25 Edge Function
// calls. It uses a temporary family with a fake 555 number (Twilio refuses
// those, so no real text goes out) and temporary board logins, and it
// briefly assigns Bishop's keyfob topic, putting back what was there.
//
// Usage: node scripts/test_help_requests.mjs [--offline]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, makeTempAdmin, purgeTempAdmins, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const env = Object.fromEntries((() => { try { return read('.env.local'); } catch { return ''; } })()
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
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-help/1.0' },
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
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const help = (action, token, extra) => fn('help_requests', action, token, extra);
const short = o => JSON.stringify(o).slice(0, 200);
// A 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// ── Offline ─────────────────────────────────────────────────────────────
console.log('Rules (offline, no calls)');
try {
  const h = await importTs(new URL('supabase/functions/_shared/help.ts', root));
  const link = h.helpLink('bishopestates', '0e82dc9e-93af-4576-816e-9519e2223750');
  check('the reply link opens the request in the member app', link === 'https://bishopestates.poolsideapp.com/m/#help=0e82dc9e-93af-4576-816e-9519e2223750', link);
  const shortText = h.replyText('Bishop Estates Cabana Club', 'Pat', 'Your new fob is at the pool house.', link);
  check('a reply text says who answered, what they said, and links back',
    /Pat/.test(shortText) && /Your new fob is at the pool house\./.test(shortText) && shortText.endsWith(link), shortText);
  const long = h.replyText('Bishop Estates Cabana Club', 'Pat', 'x'.repeat(900), link);
  check('a long reply is cut short so the text stays two messages at most', long.length <= 306 && /\.\.\./.test(long) && long.endsWith(link), String(long.length));
  check('the assigned board member and the president can see a request',
    h.canSeeHelpRequest({ assigned_admin_id: 'fob' }, { id: 'fob', isOwner: false })
    && h.canSeeHelpRequest({ assigned_admin_id: 'fob' }, { id: 'doug', isOwner: true }));
  check('other board members can\'t', !h.canSeeHelpRequest({ assigned_admin_id: 'fob' }, { id: 'party', isOwner: false })
    && !h.canSeeHelpRequest({ assigned_admin_id: null }, { id: 'party', isOwner: false }));
  // Grounds added 2026-10-04 (PLAN.md K3), for the Grounds Director.
  check('six topics, including grounds, with "Something else" last',
    Object.keys(h.TOPIC_LABELS).join(',') === 'keyfob,membership,parties,facility,grounds,other');
} catch (e) {
  check('_shared/help.ts exists', false, e.message.split('\n')[0]);
}
{
  const tasksFn = read('supabase/functions/admin_tasks/index.ts');
  check('Done on the dashboard marks the request solved', /help\.request/.test(tasksFn) && /markHelpSolved/.test(tasksFn));
}

console.log('\nMember app (E3, offline)');
{
  const app = read('m/index.html');
  check('the member home has an Ask the board button and a list of their questions',
    /Ask the board/.test(app) && /help_requests/.test(app) && /function openHelp\(/.test(app) && /id="help-list"/.test(app));
  check('the topic picker has all six topics', ['keyfob', 'membership', 'parties', 'facility', 'grounds', 'other']
    .every(t => new RegExp(`data-topic="${t}"`).test(app)));
  check('the link in the reply text opens that conversation, even after signing in',
    /#help=/.test(app) && /poolside_member_return/.test(app));
  check('"not set up for gate access" offers to ask the keyfob person',
    /member_not_authorized[\s\S]{0,400}openHelp\('keyfob'/.test(app));
  check('photos are shrunk on the phone before sending', /toBlob|toDataURL\('image\/jpeg'/.test(app));
}

console.log('\nBoard side (E4, offline)');
{
  const inbox = (() => { try { return read('club/admin/member-help.html'); } catch { return ''; } })();
  check('there is a Member help inbox page', /help_requests/.test(inbox)
    && ['list', 'get', 'reply', 'set_status', 'assign', 'topics'].every(a => new RegExp(`'${a}'`).test(inbox)));
  check('it opens a request from a dashboard link (#r=)', /#r=/.test(inbox));
  check('dashboard tasks link to it', /member-help\.html#r=/.test(read('supabase/functions/_shared/help_tasks.ts')));
  const subtabs = read('js/admin-subtabs.js');
  check('every board member can reach it from the nav', /member-help\.html',\s+scope: ''/.test(subtabs) && /'member-help\.html': 'content'/.test(subtabs)
    && /"member-help\.html":\s+"content"/.test(read('scripts/rewrite_admin_nav.py')));
  const dash = read('club/admin/index.html');
  // PLAN.md W: questions are rows in "Needs you", and Member help is a quick button.
  check('member questions show in "Needs you" on the dashboard', /help\\\.request/.test(dash) && /Member question/.test(dash) && /member-help\.html/.test(read('supabase/functions/_shared/board_home.ts')));
  check('a topic owner without pop-ups gets a warning they can\'t dismiss',
    /help_topics_mine/.test(dash) && /mustFor/.test(read('js/admin-push.js')));
}

// PLAN.md CE (Doug 11/6): "Multiple people should be able to see the member help questions".
console.log('\nCE · everyone with the topic ticked (offline)');
{
  const between = (t, a, b) => { const i = t.indexOf(a); if (i < 0) return ''; const j = t.indexOf(b, i + a.length); return t.slice(i, j < 0 ? undefined : j); };
  try {
    const h = await importTs(new URL('supabase/functions/_shared/help.ts', root));
    const r = await importTs(new URL('supabase/functions/_shared/task_routing.ts', root));
    check('CE1: everyone who gets the topic can see a question nobody has answered yet',
      h.canSeeHelpRequest({ assigned_admin_id: null }, { id: 'fac', isOwner: false }, ['doug', 'fac'])
      && !h.canSeeHelpRequest({ assigned_admin_id: null }, { id: 'party', isOwner: false }, ['doug', 'fac'])
      && h.canSeeHelpRequest({ assigned_admin_id: 'pat' }, { id: 'pat', isOwner: false }, []));
    check('CE2: …and after someone takes it, they still see it ("Pat is handling it")',
      h.canSeeHelpRequest({ assigned_admin_id: 'pat' }, { id: 'fac', isOwner: false }, ['pat', 'fac']));
    const P = (id, slug, notices, extra = {}) => ({ id, slug, title: id, notices, scopes: [], sort: 0, ...extra });
    const board = {
      positions: [P('President', 'president', ['help_keyfob', 'help_other'], { full_access: true }), P('Facilities', 'facilities', ['help_keyfob', 'help_facility']), P('Treasurer', 'treasurer', ['help_membership'])],
      holders: [{ position_id: 'President', admin_user_id: 'doug' }, { position_id: 'Facilities', admin_user_id: 'fac' }],
      logins: [{ id: 'doug', active: true, role_template: 'owner' }, { id: 'fac', active: true, role_template: 'custom' }],
    };
    check('CE1: a topic ticked on two held positions goes to both', JSON.stringify(r.topicHandlers('keyfob', board).sort()) === '["doug","fac"]', JSON.stringify(r.topicHandlers('keyfob', board)));
    check('CE1: a topic only on an empty position goes to the President, as before', JSON.stringify(r.topicHandlers('membership', board)) === '["doug"]', JSON.stringify(r.topicHandlers('membership', board)));
    check('CE3: "You handle" is every topic you get', JSON.stringify(r.myTopics('fac', board)) === '["keyfob","facility"]' && r.myTopics('doug', board).includes('keyfob'), JSON.stringify(r.myTopics('fac', board)));
  } catch (e) { check('the routing rules load', false, String(e.message).split('\n')[0]); }
  const hr = read('supabase/functions/help_requests/index.ts'), ht = read('supabase/functions/_shared/help_tasks.ts');
  const submit = between(hr, "if (action === 'submit')", "if (action === 'mine')");
  check('CE1: a new question isn\'t handed to one person', !/topicOwnerId\(/.test(hr) && /assigned_admin_id: null/.test(submit), submit.slice(0, 120));
  check('CE1: its to-do and pop-up go to everyone with the topic (its alert), until someone takes it', /req\.assigned_admin_id \? null : HELP_NOTICE\[/.test(ht) && /notice: byTopic/.test(ht));
  const reply = between(hr.slice(hr.indexOf('Board side')), "if (action === 'reply')", "if (action === 'set_status')");
  check('CE2: the first board reply takes it: theirs, and the to-do moves to them', /claimHelpTask\(/.test(reply) && /!r\.assigned_admin_id/.test(reply), reply.slice(0, 160));
  const setStatus = between(hr.slice(hr.indexOf('Board side')), "if (action === 'set_status')", "if (action === 'assign')");
  check('CE2: "I\'m on it" takes it too', /claimHelpTask\(/.test(setStatus) && /in_progress' && !r\.assigned_admin_id/.test(setStatus));
  const list = between(hr, "if (action === 'list')", "if (action === 'get')");
  check('CE1: Member help lists what\'s handed to you plus every topic you get', /\.or\(/.test(list) && /topic\.in\./.test(list) && /myTopics\(|mineTopics/.test(hr), list.slice(0, 200));
  const topics = between(hr, "if (action === 'topics')", "if (action === 'set_topics')");
  check('CE3: Who handles what lists everyone per topic, and "You handle" comes from the same rule', /handlers/.test(topics) && /topicHandlers\(/.test(topics) && !/posNotices/.test(topics), topics.slice(0, 200));
  check('CE5: someone without full access is sent only the topics that come to them', /me\.isOwner \|\| mineTopics\.includes\(t\)/.test(topics), topics.slice(0, 300));
  const at = read('supabase/functions/admin_tasks/index.ts');
  check('CE3: the dashboard says your own position ("For the Facilities Director")', /heldIds\.has|held\.find/.test(between(at, 'for_position', 'assigned_name')), between(at, '"For the Treasurer"', 'Name who').slice(0, 300));
  check('sign-ups from a member question follow the same rule', /topicHandlers\(/.test(read('supabase/functions/volunteer/index.ts')));
  const app = read('m/index.html');
  check('CE4: the family\'s app says the board members who handle it, not "the board president"', /board members who handle/.test(app) && /The board is handling this/.test(app) && !/'the board president'/.test(app) && !/'The board president is handling this'/.test(app));
  const inbox = read('club/admin/member-help.html');
  check('CE3: Member help shows everyone who handles each topic, and who\'s handling each question', /handlers/.test(inbox) && /is handling it/.test(inbox));
}

{
  const { launch, attach, BOARD } = await import('./demo_video/harness.mjs');
  const { respond } = await import('./demo_video/data.mjs');
  const browser = await launch(), p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844 });
  const H = (n, pos) => ({ admin_id: n, name: n, position: pos });
  const log = await attach(p, { state: {}, answer: (fn, body, c) => {
    if (fn === 'help_requests' && body.action === 'topics') return { ok: true, is_owner: false, mine: ['keyfob'], labels: { keyfob: 'Keyfob & gate', membership: 'Membership & dues', parties: 'Parties & events', facility: 'Pool problem', grounds: 'Grounds, bathrooms & cleaning', other: 'Something else' },
      board: [], topics: { keyfob: H('Doug Frevele', 'President') }, handlers: { keyfob: [H('Doug Frevele', 'President'), H('Mike Rivera', 'Facilities Director')], membership: [H('Doug Frevele', 'President')], parties: [], facility: [], grounds: [], other: [] } };
    if (fn === 'help_requests' && body.action === 'list') return { ok: true, is_owner: false, requests: [
      { id: 'r1', topic: 'keyfob', topic_label: 'Keyfob & gate', status: 'in_progress', assigned_name: 'Mike Rivera', member_name: 'Ana', family_name: 'Lopez', first_snippet: 'My fob stopped working', updated_at: new Date().toISOString() },
      { id: 'r2', topic: 'keyfob', topic_label: 'Keyfob & gate', status: 'open', assigned_name: null, member_name: 'Ben', family_name: 'Ortiz', first_snippet: 'Gate stuck', updated_at: new Date().toISOString(), waiting_on_board: true }] };
    return respond(fn, body, c);
  } });
  await p.goto(BOARD + '/club/admin/member-help.html', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 900));
  const v = await p.evaluate(() => ({ topics: document.getElementById('topics-body')?.textContent.replace(/\s+/g, ' ') || '', list: document.getElementById('list')?.innerText.replace(/\s+/g, ' ') || '' }));
  check('CE3: Who handles what shows both people on a shared topic', /Doug Frevele \(President\)/.test(v.topics) && /Mike Rivera \(Facilities Director\)/.test(v.topics), v.topics.slice(0, 200));
  check('CE2: Member help says who\'s handling each question, or that nobody has answered yet', /Mike Rivera is handling it/.test(v.list) && /Not answered yet/.test(v.list), v.list.slice(0, 200));
  check('CE: no page errors', !log.errors.length, log.errors.join('; '));
  // CE5: a Secretary who only gets "Something else", and someone who gets nothing.
  for (const [label, mine, handlers, want, wantNot] of [
    ['a Secretary with only Something else sees only that topic', ['other'], { other: [H('Doug Frevele', 'President'), H('Pat Lee', 'Secretary')] }, /Something else[\s\S]*Pat Lee/, /Keyfob|Membership|Parties|Pool problem|Grounds/],
    ['someone with no topics is told none come to them, and where that\'s set', [], {}, /No member-help topics come to you/, /Keyfob|Something else/],
  ]) {
    const q = await (await launch()).newPage();
    await q.setViewport({ width: 390, height: 844 });
    const lg = await attach(q, { state: {}, answer: (fn, body, c) => {
      if (fn === 'help_requests' && body.action === 'topics') return { ok: true, is_owner: false, mine, labels: { keyfob: 'Keyfob & gate', membership: 'Membership & dues', parties: 'Parties & events', facility: 'Pool problem', grounds: 'Grounds, bathrooms & cleaning', other: 'Something else' },
        board: [], topics: Object.fromEntries(Object.entries(handlers).map(([k, v]) => [k, v[0]])), handlers };
      if (fn === 'help_requests' && body.action === 'list') return { ok: true, is_owner: false, requests: [] };
      return respond(fn, body, c);
    } });
    await q.goto(BOARD + '/club/admin/member-help.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(r => setTimeout(r, 800));
    const t = await q.evaluate(() => (document.getElementById('topics-summary')?.textContent || '') + ' | ' + (document.getElementById('topics-body')?.textContent || '').replace(/\s+/g, ' '));
    check('CE5: ' + label, want.test(t) && !wantNot.test(t) && !lg.errors.length, t.slice(0, 220) + (lg.errors.length ? ' ' + lg.errors.join('; ') : ''));
    await q.browser().close();
  }
  await browser.close();
}

if (process.argv.includes('--offline')) {
  console.log(`\n${failed ? 'FAILED' : 'PASSED'} (offline only): ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

// ── Live ────────────────────────────────────────────────────────────────
console.log('\nLive, bishopestates');
const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
const [{ n: hasTable }] = await sql(`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'help_requests'`);
if (!check('help requests can be stored', hasTable === 1)) {
  console.log('  (live checks skipped until the migration is applied)');
  console.log(`\nFAILED: ${passed} passed, ${failed} failed`);
  process.exit(1);
}
const FAMILY = `SimTest help ${String(Date.now()).slice(-6)}`;
const started = new Date().toISOString();
const PHONE = `+1555010${String(Date.now()).slice(-4)}`;
// Topics go to board positions since 2026-10-04 (PLAN.md K3): keyfob & gate
// is the Facilities Director's. The test gives that position to a temporary
// login and puts its holders back afterward.
const [facilities] = await sql(`select id from board_positions where tenant_id = '${club.id}' and slug = 'facilities'`);
const savedHolders = (await sql(`select admin_user_id from board_position_holders where position_id = '${facilities.id}'`)).map(r => r.admin_user_id);
const reqTasks = id => sql(`select id, assigned_admin_id, notice, target_scopes, completed_at, dismissed_at from admin_tasks
  where source_kind = 'help_request' and source_id = '${id}' order by created_at`);
let r1, r2;
try {
  const mem = await makeTempMember(sql, club.id, FAMILY);
  await sql(`update household_members set phone_e164 = '${PHONE}' where id = '${mem.id}'`);
  const other = await makeTempMember(sql, club.id, FAMILY + ' B');
  const fobId = await makeTempAdmin(sql, club.id, 'Keyfob');
  const partyId = await makeTempAdmin(sql, club.id, 'Parties');
  const memTok = jwt({ sub: mem.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: mem.household_id });
  const otherTok = jwt({ sub: other.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: other.household_id });
  const fobTok = jwt({ sub: fobId, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const partyTok = jwt({ sub: partyId, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });

  console.log('\nWho handles what (E4, by board position since K3)');
  const st1 = await fn('board', 'set_holders', fobTok, { position_id: facilities.id, admin_ids: [fobId] });
  check('only the president can choose who handles each topic', st1.status === 403, short(st1));
  const st2 = await fn('board', 'set_holders', ownerTok, { position_id: facilities.id, admin_ids: [...savedHolders, fobId] });
  check('the president makes the keyfob person Facilities Director', st2.ok, short(st2));
  const tp = await help('topics', fobTok);
  // Bishop's President takes every topic (Doug, 10/8: "leave them alone"), and
  // since PLAN.md CE a question goes to everyone who takes it. Then a test
  // question would reach a real board member, pop-up and all, so the
  // member-help flow below is skipped while anyone else gets keyfob questions.
  const realOnKeyfob = (tp.handlers?.keyfob || []).filter(h => h.admin_id !== fobId);
  if (tp.ok && realOnKeyfob.length) {
    console.log(`  - skipped the rest: keyfob questions also go to ${realOnKeyfob.map(h => `${h.name} (${h.position})`).join(', ')}, a real board member`);
  } else flow: {
  check('the keyfob person sees that it\'s theirs', tp.ok && (tp.handlers?.keyfob || []).some(h => h.admin_id === fobId) && tp.mine?.includes('keyfob'), short(tp));
  const dt = await fn('admin_tasks', 'list', fobTok);
  check('their dashboard knows it, and that pop-ups are off everywhere for them',
    dt.ok && (dt.help_topics_mine || []).includes('Keyfob & gate') && dt.push_devices === 0, short({ mine: dt.help_topics_mine, devices: dt.push_devices }));

  console.log('\nA member asks for help (E2)');
  const s1 = await help('submit', memTok, { topic: 'keyfob', body: 'My fob stopped working at the side gate.', photo_content_type: 'image/png', photo_base64: PNG });
  r1 = s1.request?.id;
  check('a keyfob question isn\'t handed to one person (CE1)', s1.ok && !s1.request?.assigned_admin_id, short(s1));
  let t1 = await reqTasks(r1);
  check('…its to-do is the keyfob alert, for everyone who gets it', t1.length === 1 && t1[0].notice === 'help_keyfob' && !t1[0].assigned_admin_id && !t1[0].completed_at, short(t1));
  const s2 = await help('submit', memTok, { topic: 'other', body: 'Can I bring my dog to the swim meet?' });
  r2 = s2.request?.id;
  const t2 = await reqTasks(r2);
  // Since K3 it goes to whoever holds President (the position that gets
  // "something else"), named, rather than to any owner login.
  const [presHolder] = await sql(`select h.admin_user_id from board_position_holders h join board_positions p on p.id = h.position_id
    where p.tenant_id = '${club.id}' and p.slug = 'president' limit 1`);
  check('"Something else" goes by its alert (the President holds it)', s2.ok && t2.length === 1 && t2[0].notice === 'help_other' && !t2[0].assigned_admin_id
    && t2[0].target_scopes.length === 0 && !!presHolder, short(t2));

  const lf = await help('list', fobTok, { view: 'open' });
  const fobIds = (lf.requests || []).map(x => x.id);
  check('the keyfob person sees theirs, not the president\'s', fobIds.includes(r1) && !fobIds.includes(r2), short(lf));
  const lp = await help('list', partyTok, { view: 'open' });
  check('the party person sees neither', lp.ok && !(lp.requests || []).some(x => x.id === r1 || x.id === r2), short(lp));
  const gp = await help('get', partyTok, { id: r1 });
  check('…and can\'t open one', gp.status === 403 || gp.status === 404, short(gp));
  const go = await help('get', otherTok, { id: r1 });
  check('another family can\'t open it either', go.status === 403 || go.status === 404, short(go));

  const g1 = await help('get', fobTok, { id: r1 });
  const photoUrl = g1.messages?.[0]?.photo_url;
  check('the keyfob person sees the message and the photo', g1.ok && /side gate/.test(g1.messages?.[0]?.body) && !!photoUrl, short(g1));
  const photoOk = photoUrl ? (await fetch(photoUrl)).status : 0;
  const path = (await sql(`select photo_path from help_messages where request_id = '${r1}' and photo_path is not null`))[0]?.photo_path;
  const publicTry = path ? (await fetch(`${SUPABASE_URL}/storage/v1/object/public/help-photos/${path}`)).status : 0;
  check('the photo opens from the board\'s private link, but not from a public one', photoOk === 200 && publicTry >= 400,
    `private ${photoOk}, public ${publicTry}`);

  console.log('\nThe board answers (E2)');
  const b1 = await help('reply', fobTok, { id: r1, body: 'Your new fob is at the pool house. Bring your ID.' });
  check('the keyfob person replies; it\'s now being handled', b1.ok && b1.request?.status === 'in_progress', short(b1));
  const tc = await reqTasks(r1);
  check('…and it\'s theirs: the first reply takes it, and the to-do moves to them (CE2)', b1.request?.assigned_admin_id === fobId
    && tc.filter(t => !t.completed_at && !t.dismissed_at).every(t => t.assigned_admin_id === fobId && !t.notice), short(tc));
  const [sms] = await sql(`select count(*)::int as n from sms_log where to_phone = '${PHONE}' and source = 'help_requests.reply'`);
  check('…and the reply is texted to the member', sms.n === 1, `texts logged: ${sms.n}`);
  const mg = await help('get', memTok, { id: r1 });
  const lastM = mg.messages?.[mg.messages.length - 1];
  check('the member sees the reply in the app, with who sent it', /pool house/.test(lastM?.body) && lastM?.author_name === 'SimTest Keyfob', short(lastM ?? mg));
  const mine = await help('mine', memTok);
  check('the member\'s list shows both requests and their status',
    (mine.requests || []).find(x => x.id === r1)?.status === 'in_progress' && (mine.requests || []).some(x => x.id === r2), short(mine));
  const m2 = await help('reply', memTok, { id: r1, body: 'Thanks! Can my son pick it up?' });
  t1 = await reqTasks(r1);
  check('the member can reply; still one open task', m2.ok && t1.filter(t => !t.completed_at && !t.dismissed_at).length === 1, short(t1));

  console.log('\nHand-off and solving (E2)');
  const a1 = await help('assign', fobTok, { id: r1, admin_id: partyId });
  t1 = await reqTasks(r1);
  const openT = t1.filter(t => !t.completed_at && !t.dismissed_at);
  check('the keyfob person hands it to the party person', a1.ok && a1.request?.assigned_name === 'SimTest Parties'
    && openT.length === 1 && openT[0].assigned_admin_id === partyId, short(t1));
  const notes = await sql(`select body from help_messages where request_id = '${r1}' and author_kind = 'note'`);
  check('…and the conversation notes the hand-off', notes.some(n => /SimTest Parties/.test(n.body)), short(notes));
  const lf2 = await help('list', fobTok, { view: 'open' });
  check('the keyfob person still sees it (they get keyfob questions), as the party person\'s', lf2.ok && (lf2.requests || []).find(x => x.id === r1)?.assigned_name === 'SimTest Parties', short(lf2));
  const sv = await help('set_status', partyTok, { id: r1, status: 'solved' });
  t1 = await reqTasks(r1);
  check('solving it clears it from the dashboard', sv.ok && sv.request?.status === 'solved' && t1.every(t => t.completed_at || t.dismissed_at), short(t1));
  await help('reply', memTok, { id: r1, body: 'Actually it still does not work.' });
  const [re] = await sql(`select status from help_requests where id = '${r1}'`);
  t1 = await reqTasks(r1);
  const reopened = t1.filter(t => !t.completed_at && !t.dismissed_at);
  check('a member reply to a solved request reopens it, back on the dashboard',
    re.status === 'open' && reopened.length === 1 && reopened[0].assigned_admin_id === partyId, short({ re, t1 }));
  const done = await fn('admin_tasks', 'complete', partyTok, { id: reopened[0]?.id });
  const [re2] = await sql(`select status from help_requests where id = '${r1}'`);
  check('Done on the dashboard marks it solved', done.ok && re2.status === 'solved', short(re2));

  const d1 = await help('delete', partyTok, { id: r2 });
  check('only the president can delete a request', d1.status === 403 || d1.status === 404, short(d1));
  const d2 = await help('delete', ownerTok, { id: r1 });
  // Check storage itself: a link opened a moment ago can still be served
  // from the CDN's cache until it expires.
  const [{ n: stored }] = await sql(`select count(*)::int as n from storage.objects where bucket_id = 'help-photos' and name = '${path}'`);
  check('the president can, and its photo is deleted', d2.ok && stored === 0, `delete ${short(d2)}, photo rows ${stored}`);
  if (d2.ok) r1 = null;
  const d3 = await help('delete', ownerTok, { id: r2 });
  if (d3.ok) r2 = null;
  }
} finally {
  await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
  await purgeTempAdmins(sql, club.id);
  await sql(`delete from audit_log where tenant_id = '${club.id}' and kind like 'board_position.%' and created_at >= '${started}'`);
}
const [{ n: left }] = await sql(`select (select count(*) from help_requests hr join households h on h.id = hr.household_id
    where h.family_name like 'SimTest%') + (select count(*) from admin_users where username like 'simtest-%') as n`);
const holdersNow = (await sql(`select admin_user_id from board_position_holders where position_id = '${facilities.id}'`)).map(r => r.admin_user_id);
check('test families, logins and requests removed; Facilities Director put back',
  Number(left) === 0 && JSON.stringify(holdersNow.sort()) === JSON.stringify(savedHolders.sort()), `left=${left}, holders=${JSON.stringify(holdersNow)}`);

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

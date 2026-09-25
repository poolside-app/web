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
  const shortText = h.replyText('Bishop Estates Cabana Club', 'Kristin', 'Your new fob is at the pool house.', link);
  check('a reply text says who answered, what they said, and links back',
    /Kristin/.test(shortText) && /Your new fob is at the pool house\./.test(shortText) && shortText.endsWith(link), shortText);
  const long = h.replyText('Bishop Estates Cabana Club', 'Kristin', 'x'.repeat(900), link);
  check('a long reply is cut short so the text stays two messages at most', long.length <= 306 && /\.\.\./.test(long) && long.endsWith(link), String(long.length));
  check('the assigned board member and the president can see a request',
    h.canSeeHelpRequest({ assigned_admin_id: 'fob' }, { id: 'fob', isOwner: false })
    && h.canSeeHelpRequest({ assigned_admin_id: 'fob' }, { id: 'doug', isOwner: true }));
  check('other board members can\'t', !h.canSeeHelpRequest({ assigned_admin_id: 'fob' }, { id: 'party', isOwner: false })
    && !h.canSeeHelpRequest({ assigned_admin_id: null }, { id: 'party', isOwner: false }));
  check('five topics, "Something else" going to the president',
    Object.keys(h.TOPIC_LABELS).join(',') === 'keyfob,membership,parties,facility,other');
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
  check('the topic picker has all five topics', ['keyfob', 'membership', 'parties', 'facility', 'other']
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
    && ['list', 'get', 'reply', 'set_status', 'assign', 'topics', 'set_topics'].every(a => new RegExp(`'${a}'`).test(inbox)));
  check('it opens a request from a dashboard link (#r=)', /#r=/.test(inbox));
  check('dashboard tasks link to it', /member-help\.html#r=/.test(read('supabase/functions/_shared/help_tasks.ts')));
  const subtabs = read('js/admin-subtabs.js');
  check('every board member can reach it from the nav', /member-help\.html',\s+scope: ''/.test(subtabs) && /'member-help\.html': 'content'/.test(subtabs)
    && /"member-help\.html":\s+"content"/.test(read('scripts/rewrite_admin_nav.py')));
  const dash = read('club/admin/index.html');
  check('the dashboard has a Member help card', /member-help\.html/.test(dash) && /id="member-help-card"/.test(dash));
  check('a topic owner without pop-ups gets a warning they can\'t dismiss',
    /help_topics_mine/.test(dash) && /mustFor/.test(read('js/admin-push.js')));
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
const PHONE = `+1555010${String(Date.now()).slice(-4)}`;
const [{ topics: savedTopics }] = await sql(`select value->'help_topics' as topics from settings where tenant_id = '${club.id}'`);
const reqTasks = id => sql(`select id, assigned_admin_id, target_scopes, completed_at, dismissed_at from admin_tasks
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

  console.log('\nWho handles what (E4)');
  const keep = { ...(savedTopics || {}), keyfob: fobId };
  const st1 = await help('set_topics', fobTok, { topics: keep });
  check('only the president can choose who handles each topic', st1.status === 403, short(st1));
  const st2 = await help('set_topics', ownerTok, { topics: keep });
  check('the president hands keyfob & gate to the keyfob person', st2.ok, short(st2));
  const tp = await help('topics', fobTok);
  check('the keyfob person sees that it\'s theirs', tp.ok && tp.topics?.keyfob?.admin_id === fobId && tp.mine?.includes('keyfob'), short(tp));
  const dt = await fn('admin_tasks', 'list', fobTok);
  check('their dashboard knows it, and that pop-ups are off everywhere for them',
    dt.ok && (dt.help_topics_mine || []).includes('Keyfob & gate') && dt.push_devices === 0, short({ mine: dt.help_topics_mine, devices: dt.push_devices }));

  console.log('\nA member asks for help (E2)');
  const s1 = await help('submit', memTok, { topic: 'keyfob', body: 'My fob stopped working at the side gate.', photo_content_type: 'image/png', photo_base64: PNG });
  r1 = s1.request?.id;
  check('a keyfob question goes to the keyfob person', s1.ok && s1.request?.assigned_name === 'SimTest Keyfob', short(s1));
  let t1 = await reqTasks(r1);
  check('…and on their dashboard', t1.length === 1 && t1[0].assigned_admin_id === fobId && !t1[0].completed_at, short(t1));
  const s2 = await help('submit', memTok, { topic: 'other', body: 'Can I bring my dog to the swim meet?' });
  r2 = s2.request?.id;
  const t2 = await reqTasks(r2);
  check('"Something else" goes to the president', s2.ok && s2.request?.assigned_name === null
    && t2.length === 1 && t2[0].assigned_admin_id === null && t2[0].target_scopes.length === 0, short(t2));

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
  check('it\'s no longer on the keyfob person\'s list', lf2.ok && !(lf2.requests || []).some(x => x.id === r1));
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
} finally {
  await sql(`update settings set value = ${savedTopics == null ? `value - 'help_topics'` : `jsonb_set(value, '{help_topics}', '${JSON.stringify(savedTopics).replace(/'/g, "''")}'::jsonb)`}
    where tenant_id = '${club.id}'`);
  await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
  await purgeTempAdmins(sql, club.id);
}
const [{ n: left }] = await sql(`select (select count(*) from help_requests hr join households h on h.id = hr.household_id
    where h.family_name like 'SimTest%') + (select count(*) from admin_users where username like 'simtest-%') as n`);
const [{ t: topicsNow }] = await sql(`select value->'help_topics' as t from settings where tenant_id = '${club.id}'`);
check('test families, logins and requests removed; keyfob topic put back',
  Number(left) === 0 && JSON.stringify(topicsNow) === JSON.stringify(savedTopics), `left=${left}, topics=${JSON.stringify(topicsNow)}`);

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

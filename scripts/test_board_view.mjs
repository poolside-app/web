#!/usr/bin/env node
// The President's look-only preview of a board member's or a position's
// board (PLAN.md CC). Doug 11/6: "is there a way i can see each board members
// board page as i have selected their options..? just a view somehow?", then
// "i dont want to need to invite someone.. just see and interacti with thier
// interface": their screens open too, look only.
//
// Offline: the rules in _shared/board_view.ts, the functions' wiring (every
// read the relay passes on writes nothing), and in Chrome the Board page's
// buttons and the preview (every call answered by the demo club,
// scripts/demo_video/data.mjs). Costs nothing.
//
// Usage: node scripts/test_board_view.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { launch, attach, BOARD } from './demo_video/harness.mjs';
import { respond } from './demo_video/data.mjs';
import { siteRespond } from './demo_video/site_data.mjs';

const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
// Each `if (… action === 'x' …) { … }` block in a function, brace-matched.
function blocks(src, action) {
  const out = [];
  const re = new RegExp(`if \\(([^\\n{]*?)action === '${action}'([^\\n{]*?)\\)\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length, depth = 1;
    while (depth && i < src.length) { if (src[i] === '{') depth++; else if (src[i] === '}') depth--; i++; }
    out.push({ cond: m[1] + m[2], body: src.slice(m.index, i) });
  }
  // One-line handlers: `if (action === 'x') return …;`
  const one = new RegExp(`if \\(([^\\n{]*?)action === '${action}'([^\\n{]*?)\\) return [^\\n]*`, 'g');
  while ((m = one.exec(src))) out.push({ cond: m[1] + m[2], body: m[0] });
  return out;
}
// The code that runs for this action: each block that names it, without the
// branches for the other actions it shares a block with, and up to its own
// early return.
function codeFor(src, action) {
  return blocks(src, action).map(b => {
    let body = b.body;
    const others = [...b.cond.matchAll(/action === '([a-z_0-9]+)'/g)].map(x => x[1]).filter(x => x !== action);
    for (const o of others) for (const ib of blocks(body, o)) if (ib.body !== body) body = body.replace(ib.body, '');
    // Its own branch inside a shared block returns: nothing after it runs for this action.
    const mine = blocks(body, action).find(ib => ib.body !== body && !/\|\|/.test(ib.cond) && /\breturn\b/.test(ib.body));
    if (mine && /\{/.test(mine.body)) body = body.slice(0, body.indexOf(mine.body) + mine.body.length);
    const early = new RegExp(`if \\(action === '${action}'\\) return [^\\n]*`).exec(body);
    if (early && early.index > 0) body = body.slice(0, early.index + early[0].length);
    return body;
  });
}
const WRITES = /\.(insert|update|upsert|delete)\(|\.rpc\(|sendSms\(|sendEmail\(|notify\w*\(|\.upload\(|\.remove\(|createSignedUploadUrl/;

console.log('CC1, CC5 · the look-only sign-in (_shared/board_view.ts)');
let bv = null;
try { bv = await importTs(new URL('supabase/functions/_shared/board_view.ts', root)); }
catch (e) { check('_shared/board_view.ts loads', false, String(e.message).slice(0, 120)); }
if (bv) {
  check('its own kind, board_view, for an hour', bv.VIEW_KIND === 'board_view' && bv.VIEW_SECONDS === 3600);
  check('the reads worked out as them: who\'s signed in, the home, the setup list, Member help', JSON.stringify(bv.VIEW_READS) === JSON.stringify({
    tenant_admin_auth: ['me'], admin_tasks: ['home', 'list', 'count'], tenant_settings: ['setup_status'], help_requests: ['list', 'get', 'topics'] }), JSON.stringify(bv.VIEW_READS));
  const no = [['admin_tasks', 'complete'], ['admin_tasks', 'dismiss'], ['tenant_admin_auth', 'handoff'], ['tenant_admin_auth', 'view_as'],
    ['tenant_admin_auth', 'invite_admin'], ['gate_admin', 'board_unlock'], ['push_admin', 'subscribe'], ['tenant_settings', 'save'],
    ['applications', 'approve'], ['payment_plans', 'approve'], ['help_requests', 'reply'], ['keyfobs', 'issue'], ['keyfobs', 'sync_send'],
    ['gate_admin', 'pass_create'], ['board', 'set_holders'], ['sms_blasts', 'approve'], ['email_templates', 'preview'], ['email_templates', 'outbox_send_now'],
    ['admin_tasks', 'toString'], ['__proto__', 'me'], ['', ''], ['board_preview', 'list'], ['tenant_admin_auth', 'me']];
  check('anything that changes something is refused, directly or through the relay', no.every(([f, a]) => !(f === 'tenant_admin_auth' && a === 'me' ? false : bv.viewAllowed(f, a)) && !bv.previewReadAllowed(f, a)),
    no.filter(([f, a]) => (bv.viewAllowed(f, a) && !(f === 'tenant_admin_auth' && a === 'me')) || bv.previewReadAllowed(f, a)).join(' '));
  check('the reads it needs are allowed', [['tenant_admin_auth', 'me'], ['admin_tasks', 'home'], ['admin_tasks', 'list'], ['tenant_settings', 'setup_status'], ['help_requests', 'list']].every(([f, a]) => bv.viewAllowed(f, a)));
  const c = bv.viewClaims({ target: 'u-erik', tid: 't1', slug: 'maple', by: 'u-sam', byName: 'Sam Brooks', nowSec: 1000 });
  check('a person\'s sign-in names who it\'s for and who\'s looking', c.kind === 'board_view' && c.sub === 'u-erik' && c.tid === 't1' && c.slug === 'maple'
    && c.by === 'u-sam' && c.by_name === 'Sam Brooks' && c.exp === 4600 && !('scopes' in c) && !('role_template' in c) && !c.pos, JSON.stringify(c));
  check('a real board sign-in is not a preview, nor one missing who\'s looking', !bv.asView({ ...c, kind: 'tenant_admin' }) && !bv.asView({ ...c, by: '' })
    && !bv.asView({ ...c, by: c.sub }) && !bv.asView(null) && bv.asView(c)?.sub === 'u-erik');
  const pc = bv.viewClaims({ position: 'pos-fac', tid: 't1', slug: 'maple', by: 'u-sam', byName: 'Sam Brooks', nowSec: 1000 });
  check('CC5: a position\'s sign-in has the position and nobody in it', pc.pos === 'pos-fac' && pc.sub === bv.NIL && bv.NIL === '00000000-0000-0000-0000-000000000000' && bv.asView(pc)?.pos === 'pos-fac', JSON.stringify(pc));
  check('CC5: nobody without a position, or a person with one, is not a preview', !bv.asView({ ...pc, pos: '' }) && !bv.asView({ ...c, pos: 'pos-fac' }));
  const me = { id: 'u-sam', tid: 't1', isOwner: true };
  const erik = { id: 'u-erik', tenant_id: 't1', active: true, role_template: 'custom' };
  check('the President can see a board member\'s view', bv.canPreview(me, erik) === null, bv.canPreview(me, erik));
  check('…not anyone else', !!bv.canPreview({ ...me, isOwner: false }, erik));
  check('…not another club\'s, a removed one, a gate login, or their own', [
    { ...erik, tenant_id: 't2' }, { ...erik, active: false }, { ...erik, role_template: 'gate_attendant' }, { ...erik, id: 'u-sam' }, null,
  ].every(t => typeof bv.canPreview(me, t) === 'string'));
  const pos = { id: 'pos-fac', tenant_id: 't1', title: 'Facilities Director', scopes: ['keyfobs', 'events'] };
  check('CC5: the President can see any of the club\'s positions; nobody else, and no other club\'s', bv.canPreviewPosition(me, pos) === null
    && !!bv.canPreviewPosition({ ...me, isOwner: false }, pos) && !!bv.canPreviewPosition(me, { ...pos, tenant_id: 't2' }) && !!bv.canPreviewPosition(me, null));
  const u = bv.positionUser(pos, 'Sam Brooks');
  check('CC5: as the position: its title, its screens, not the President', u.id === bv.NIL && u.display_name === 'Facilities Director' && u.board_title === 'Facilities Director'
    && u.role_template === 'custom' && JSON.stringify(u.scopes) === '["keyfobs","events"]' && u.active === true && u.is_default_pw === false && u.impersonated === false
    && u.viewing && u.viewing.position === true && u.viewing.by_name === 'Sam Brooks', JSON.stringify(u));
  const patched = bv.previewPatch({ ok: true, is_owner: true, me: 'u-sam', rows: [1] }, { me: bv.NIL, isOwner: false });
  check('CC6: the relay answers as the preview (whether they\'re the President, who "me" is)', patched.is_owner === false && patched.me === bv.NIL && patched.rows.length === 1
    && JSON.stringify(bv.previewPatch({ ok: true, list: [] }, { me: 'x', isOwner: false })) === '{"ok":true,"list":[]}');
}

console.log('CC1, CC6 · the functions');
{
  const fnDir = new URL('supabase/functions/', root);
  const fns = readdirSync(fnDir).filter(d => d !== '_shared' && existsSync(new URL(`${d}/index.ts`, fnDir)));
  const src = Object.fromEntries(fns.map(d => [d, read(`supabase/functions/${d}/index.ts`)]));
  const unchecked = fns.filter(d => /await verify\(/.test(src[d]) && !/\bkind\s*(!==|===)\s*['"]/.test(src[d]) && !/asView\(/.test(src[d]));
  check('every function that reads a sign-in checks its kind, so a preview can do nothing by default', !unchecked.length, unchecked.join(', '));
  const users = fns.filter(d => /board_view/.test(src[d])).sort();
  check('only the relay and the four worked out as them take a preview', JSON.stringify(users) === JSON.stringify(['admin_tasks', 'board_preview', 'help_requests', 'tenant_admin_auth', 'tenant_settings']), users.join(', '));
  const auth = src.tenant_admin_auth || '';
  const gate = between(auth, 'Auth required for everything below', "action === 'handoff'");
  check('tenant_admin_auth refuses a preview everything but me, before any other step, with 403', /asView\(/.test(gate) && /viewAllowed\('tenant_admin_auth', action\)/.test(gate) && /LOOK_ONLY/.test(gate) && /403/.test(gate), gate.slice(0, 200));
  const meSrc = between(auth, "if (action === 'me')", "action === 'change_password'");
  check('me answers as them, never renews a preview into a real sign-in, and says who\'s looking', /!payload\.viewing_by/.test(between(meSrc, 'let renewed_token', 'return jsonResponse')) && /viewing:/.test(meSrc));
  check('CC5: me answers as the position when the preview is one', /viewing_pos/.test(meSrc) && /positionUser\(/.test(meSrc));
  const va = between(auth, "action === 'view_as'", "\n  if (action === '");
  check('view_as: the President only, by the club\'s own rules, an hour', /requireOwner\(/.test(va) && /canPreview\(/.test(va) && /viewClaims\(/.test(va) && /tenant_id/.test(va), va.slice(0, 160));
  check('CC5: view_as takes a position too, the club\'s own', /position_id/.test(va) && /canPreviewPosition\(/.test(va) && /board_positions/.test(va));
  check('a preview is never handed off to a Home Screen app', /viewing_by/.test(between(auth, "action === 'handoff'", 'return jsonResponse({ ok: true, token: tok')));
  for (const fn of ['admin_tasks', 'tenant_settings', 'help_requests']) {
    const s = src[fn] || '';
    const head = s.slice(s.indexOf('Deno.serve'), s.indexOf("action === '", s.indexOf('Deno.serve')));
    check(`${fn} refuses a preview anything but its reads, with 403, before any work`, /asView\(/.test(head) && new RegExp(`viewAllowed\\('${fn}', action\\)`).test(head) && /LOOK_ONLY/.test(head) && /403/.test(head), head.slice(-300));
  }
  check('CC5: the home and Member help work out a position\'s alerts and assigned questions', /view\.pos|view\?\.pos/.test(src.admin_tasks || '') && /positionPreview\(/.test(src.admin_tasks || '')
    && /view\.pos|view\?\.pos/.test(src.help_requests || '') && /sees/.test(src.help_requests || '') && /positionPreview\(/.test(src.help_requests || ''));

  // CC6: the relay's list is reads only, each a real action that writes nothing.
  if (bv) {
    const bad = [], housekeeping = [];
    for (const [fn, acts] of Object.entries(bv.PREVIEW_READS)) {
      for (const a of acts) {
        const code = codeFor(src[fn] || '', a);
        if (!code.length) { bad.push(`${fn}:${a} (no such action)`); continue; }
        const writes = code.filter(b => WRITES.test(b));
        if (!writes.length) continue;
        if (bv.TIDY_READS.includes(`${fn}:${a}`)) { housekeeping.push(`${fn}:${a}`); continue; }
        bad.push(`${fn}:${a} (${(writes[0].match(WRITES) || [])[0]})`);
      }
    }
    check('CC6: every read the relay passes on is a real action that writes nothing', !bad.length, bad.join(', '));
    check('CC6: the three that tidy up as they read (for anyone) are named', JSON.stringify(housekeeping.sort()) === JSON.stringify([...bv.TIDY_READS].sort()), housekeeping.join(', '));
    check('CC6: the relay never passes on sign-in, Stripe checkout, pop-up, hand-off or texting functions', !['tenant_admin_auth', 'stripe_checkout', 'push_admin', 'member_auth', 'sms_blasts_send', 'board_preview'].some(f => f in bv.PREVIEW_READS)
      && Object.keys(bv.PREVIEW_READS).every(f => fns.includes(f)));
  }
  const relay = src.board_preview || '';
  const serve = relay.indexOf('Deno.serve');
  const iView = relay.indexOf('asView(', serve), iList = relay.indexOf('previewReadAllowed(', serve), iPres = relay.indexOf('isOwnerRow(by)', serve), iFwd = relay.indexOf('fetch(', serve);
  check('CC6: board_preview takes only a preview, checks the list, then that the President is still President, then asks', !!relay && iView > 0 && iList > iView && iPres > iList && iFwd > iPres,
    [iView, iList, iPres, iFwd].join(','));
  check('CC6: …as the President for a minute, with the checked action, answering as the preview', /exp:\s*now\s*\+\s*60/.test(relay) && /\.\.\.inner,\s*action\s*\}/.test(relay) && /previewPatch\(/.test(relay) && /LOOK_ONLY/.test(relay));
}

console.log('CC2–CC6 · in Chrome');
{
  const flags = read('js/admin-flags.js');
  const pages = readdirSync(new URL('club/admin/', root)).filter(f => f.endsWith('.html') && /admin-subtabs\.js/.test(read(`club/admin/${f}`)));
  const first = pages.filter(f => { const s = read(`club/admin/${f}`), h = s.indexOf('<head>'); return h >= 0 && s.indexOf('<script', h) === s.indexOf('<script src="/js/board-view.js"></script>', h); });
  check(`CC6: every board page loads board-view.js before anything else (${pages.length})`, pages.length >= 25 && first.length === pages.length, pages.filter(f => !first.includes(f)).join(', '));
  check('CC6: a page without it, opened in a preview tab, goes back to the preview', /poolside_view_token/.test(flags) && /!window\.BoardView/.test(flags));
  const VIEW = 'VIEWTOKEN.erik', VIEWPOS = 'VIEWTOKEN.position';
  const ERIK = { id: 'adm-larsen', email: 'facilities@example.com', display_name: 'Erik Larsen', is_super: false, is_default_pw: true, active: true,
    scopes: ['keyfobs', 'events'], role_template: 'custom', roles: ['custom'], linked_member_id: 'hh-1', member_apply_dismissed: true,
    board_title: 'Facilities Director', impersonated: false, viewing: { by_name: 'Sam Brooks' } };
  const POS = { id: 'pos-facilities', title: 'Facilities Director', purpose: 'Keeps the pool running.', description: '', notices: [], scopes: ['keyfobs', 'events'], holders: [], vacant_goes_to: null, sort: 3 };
  const POSUSER = bv ? bv.positionUser({ ...POS, tenant_id: 't' }, 'Sam Brooks') : {};
  const browser = await launch();
  const calls = [];
  const answer = (fn, body, ctx) => {
    if (fn === 'board_preview') { const inner = answer(body.fn, { ...(body.body || {}), action: body.action }, ctx); return bv ? bv.previewPatch(inner ?? { ok: true }, { me: bv.NIL, isOwner: false }) : inner; }
    if (fn === 'tenant_admin_auth' && body.action === 'view_as') {
      if (body.admin_id === 'adm-larsen') return { ok: true, token: VIEW };
      if (body.position_id === 'pos-facilities') return { ok: true, token: VIEWPOS };
      return { ok: false, error: 'no' };
    }
    if (fn === 'tenant_admin_auth' && body.action === 'me' && ctx.viewing) { const m = respond(fn, body, ctx); return { ...m, user: ctx.viewing === 'pos' ? POSUSER : ERIK }; }
    if (fn === 'board' && body.action === 'get') { const g = siteRespond(fn, body, ctx); return { ...g, positions: [POS] }; }
    return siteRespond(fn, body, ctx) ?? respond(fn, body, ctx);
  };
  const watch = page => page.on('request', r => {
    const m = r.url().match(/functions\/v1\/([a-z_]+)/); if (!m || r.method() !== 'POST') return;
    let a = '', inner = null; try { const b = JSON.parse(r.postData() || '{}'); a = b.action || ''; inner = b.fn || null; } catch { /* not json */ }
    const auth = r.headers().authorization || '';
    calls.push({ fn: m[1], action: a, inner, view: auth === `Bearer ${VIEW}` || auth === `Bearer ${VIEWPOS}` });
  });
  const open = async viewing => {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
    await p.setViewport({ width: 390, height: 844 });
    const ctx = { viewing };
    const log = await attach(p, { state: {}, answer: (fn, body, c) => answer(fn, body, { ...c, viewing: ctx.viewing }) });
    watch(p);
    return { p, log, ctx };
  };
  const settle = ms => new Promise(r => setTimeout(r, ms));

  // CC2, CC5: the Board page's buttons.
  {
    const { p, log } = await open();
    await p.goto(BOARD + '/club/admin/board.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await settle(600);
    const rows = await p.evaluate(() => [...document.querySelectorAll('#members .mrow')].map(r => ({ name: r.querySelector('.nm')?.textContent || '', see: !!r.querySelector('[data-see]') })));
    check('CC2: "See their view" beside each board member but you', rows.length === 3 && rows.filter(r => r.see).length === 2 && !rows.find(r => /\(you\)/.test(r.name))?.see, JSON.stringify(rows));
    const posBtn = await p.evaluate(() => [...document.querySelectorAll('[data-see-pos]')].map(b => b.dataset.seePos + ':' + b.textContent.trim()));
    check('CC5: "See this position\'s view" on each position', posBtn.length === 1 && /pos-facilities:See this position.s view/.test(posBtn[0]), JSON.stringify(posBtn));
    await p.evaluate(() => { const b = document.querySelector('#members [data-see="adm-larsen"]'); if (b) b.click(); });
    await p.waitForNavigation({ timeout: 8000 }).catch(() => {});
    await settle(300);
    check('CC2: tapping it asks for their look-only sign-in and opens their home in this tab', calls.some(c => c.fn === 'tenant_admin_auth' && c.action === 'view_as')
      && new URL(p.url()).pathname === '/club/admin/', p.url());
    check('CC2: no page errors', !log.errors.length, log.errors.join('; '));
    await p.close();
  }

  // CC3, CC6: a person's preview: their home, then their screens.
  calls.length = 0;
  {
    const { p, log, ctx } = await open();
    await p.goto(BOARD + '/robots.txt').catch(() => {});
    await p.evaluate(() => localStorage.setItem('keep_me', '1'));
    const realBefore = await p.evaluate(() => ({ t: localStorage.getItem('poolside_tenant_token'), u: localStorage.getItem('poolside_tenant_user'), k: localStorage.getItem('keep_me') }));
    ctx.viewing = 'person';
    await p.goto(BOARD + '/club/admin/#view=' + encodeURIComponent(VIEW), { waitUntil: 'networkidle0', timeout: 45000 });
    await settle(1000);
    const st = await p.evaluate(() => ({
      bar: document.getElementById('board-view-bar')?.innerText.replace(/\s+/g, ' ') || '', hash: location.hash, path: location.pathname,
      tabs: [...document.querySelectorAll('#btabs [data-btab]')].map(a => a.dataset.btab),
    }));
    check('CC2: the bar says whose view it is and that it\'s look only', /Viewing as Erik Larsen/.test(st.bar) && /Facilities Director/.test(st.bar) && /Look only/i.test(st.bar), st.bar);
    check('CC3: the sign-in is gone from the address', st.hash === '' && st.path === '/club/admin/', st.hash);
    check('CC2: their bottom bar: Home, their sections, More (no Money or Settings)', st.tabs[0] === 'home' && st.tabs.includes('members') && st.tabs.includes('calendar')
      && !st.tabs.includes('money') && !st.tabs.includes('settings'), st.tabs.join(','));
    const viewCalls = calls.filter(c => c.view && c.fn !== 'board_preview');
    check('CC3: every direct call it made is one worked out as them', viewCalls.length >= 2 && viewCalls.every(c => bv && bv.viewAllowed(c.fn, c.action)), JSON.stringify(viewCalls));
    check('CC3: it never used your own sign-in', !calls.some(c => !c.view && !['tenant_public'].includes(c.fn)), JSON.stringify(calls.filter(c => !c.view)));
    const before = calls.length;
    const res = await p.evaluate(async v => {
      const r = await fetch('https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/admin_tasks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + v }, body: JSON.stringify({ action: 'complete', id: 't1' }) });
      return { status: r.status, body: await r.json() };
    }, VIEW);
    check('CC3: a change (marking a to-do done) is stopped on the phone with "look only"', res.status === 403 && /look-only/i.test(res.body.error || '') && calls.length === before, JSON.stringify(res));
    // CC6: a tab opens their screen, in the preview, its reads through the relay.
    calls.length = 0;
    await p.evaluate(() => { const a = document.querySelector('#btabs [data-btab="members"]'); if (a) a.click(); });
    await p.waitForNavigation({ timeout: 10000 }).catch(() => {});
    await settle(1200);
    const kf = await p.evaluate(() => ({ path: location.pathname, bar: !!document.getElementById('board-view-bar'), blocked: !!document.getElementById('board-view-cant') }));
    check('CC6: tapping Members opens their Keyfobs screen, still in the preview', kf.path === '/club/admin/keyfobs.html' && kf.bar && !kf.blocked, JSON.stringify(kf));
    const relayed = calls.filter(c => c.fn === 'board_preview').map(c => `${c.inner}:${c.action}`);
    check('CC6: its reads went through the relay, nothing straight to the screen\'s function', relayed.includes('keyfobs:list') && !calls.some(c => c.view && c.fn === 'keyfobs'), JSON.stringify(calls));
    check('CC6: nothing it sent was a change', calls.filter(c => c.view).every(c => c.fn === 'board_preview' ? bv.previewReadAllowed(c.inner, c.action) : bv.viewAllowed(c.fn, c.action)), JSON.stringify(calls));
    check('CC6: no page errors', !log.errors.length, log.errors.join('; '));
    // A screen they can't open says so.
    await p.goto(BOARD + '/club/admin/payments.html', { waitUntil: 'networkidle0', timeout: 45000 }).catch(() => {});
    await settle(1200);
    const pay = await p.evaluate(() => ({ path: location.pathname, cant: document.getElementById('board-view-cant')?.innerText || '' }));
    check('CC6: a screen they can\'t open says so, with Back', pay.path === '/club/admin/payments.html' && /Erik can.t open this screen/.test(pay.cant) && /Back/.test(pay.cant), JSON.stringify(pay));
    // Your own sign-in, seen from another tab, is untouched.
    const other = await browser.newPage();
    await attach(other, { state: {} });
    await other.goto(BOARD + '/robots.txt').catch(() => {});
    const real = await other.evaluate(() => ({ t: localStorage.getItem('poolside_tenant_token'), u: localStorage.getItem('poolside_tenant_user'), k: localStorage.getItem('keep_me') }));
    check('CC3: your own sign-in and saved things are untouched', !!realBefore.t && real.t === realBefore.t && real.u === realBefore.u && real.k === '1' && real.t !== VIEW, JSON.stringify(real));
    await other.close();
    // Close.
    await p.evaluate(() => { const b = document.querySelector('#board-view-bar [data-close]'); if (b) b.click(); });
    await p.waitForNavigation({ timeout: 8000 }).catch(() => {});
    const after = await p.evaluate(() => ({ path: location.pathname, view: sessionStorage.getItem('poolside_view_token'), t: localStorage.getItem('poolside_tenant_token') }));
    check('CC2: Close ends the preview and goes back to Settings → Board, signed in as you', after.path === '/club/admin/board.html' && !after.view && after.t === realBefore.t, JSON.stringify(after));
    await p.close();
  }

  // CC5: a position's preview, nobody needed.
  calls.length = 0;
  {
    const { p, log, ctx } = await open();
    await p.goto(BOARD + '/club/admin/board.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await settle(500);
    ctx.viewing = 'pos';
    await p.evaluate(() => { const b = document.querySelector('[data-see-pos="pos-facilities"]'); if (b) b.click(); });
    await p.waitForNavigation({ timeout: 8000 }).catch(() => {});
    await settle(1200);
    const st = await p.evaluate(() => ({ path: location.pathname, bar: document.getElementById('board-view-bar')?.innerText.replace(/\s+/g, ' ') || '',
      tabs: [...document.querySelectorAll('#btabs [data-btab]')].map(a => a.dataset.btab) }));
    check('CC5: it asks for the position\'s look-only sign-in and opens its home', calls.some(c => c.fn === 'tenant_admin_auth' && c.action === 'view_as') && st.path === '/club/admin/', st.path);
    check('CC5: the bar names the position, not a person', /Viewing as the Facilities Director/.test(st.bar) && /Look only/i.test(st.bar), st.bar);
    check('CC5: its bottom bar is the position\'s screens', st.tabs.includes('members') && st.tabs.includes('calendar') && !st.tabs.includes('money'), st.tabs.join(','));
    check('CC5: no page errors', !log.errors.length, log.errors.join('; '));
    await p.close();
  }
  // CC7: what Doug found on the Secretary's preview, which real board members had too.
  {
    const SEC = { id: 'adm-sec', email: 'sec@example.com', display_name: 'Pat Secretary', is_super: false, is_default_pw: false, active: true,
      scopes: ['households', 'events', 'volunteer', 'announcements', 'photos', 'policies', 'directory', 'meetings'], role_template: 'custom', roles: ['custom'],
      linked_member_id: null, member_apply_dismissed: false, board_title: 'Secretary', impersonated: false };
    const asSec = async () => {
      const p = await browser.newPage();
      await p.setViewport({ width: 390, height: 844 });
      const log = await attach(p, { state: {}, answer: (fn, body, c) => {
        if (fn === 'tenant_admin_auth' && body.action === 'me') return { ...respond(fn, body, c), user: SEC };
        if (fn === 'tenant_settings' && body.action === 'setup_status') return { ok: true, done: 8, total: 10, percent: 80, complete: false, items: [
          { id: 'logo', label: 'Upload your club logo', done: true, fix_url: '/club/admin/settings.html', fix_label: 'Upload' },
          { id: 'self_signup', label: 'Sign up your own family', done: false, can_skip: true, why: 'Same form your members use, so you see it the way they do. Not a swimmer? Mark it done.', fix_url: '/apply.html?prefill=admin', fix_label: 'Sign up' },
          { id: 'invite_board', label: 'Set up your board positions', done: false, why: 'Each position gets its own alerts and screens.', fix_url: '/club/admin/board.html', fix_label: 'Set up' },
        ] };
        return siteRespond(fn, body, c) ?? respond(fn, body, c);
      } });
      // Their own saved sign-in, as admin-flags.js keeps it.
      await p.evaluateOnNewDocument(u => { try { localStorage.setItem('poolside_tenant_user', u); } catch (_) {} }, JSON.stringify(SEC));
      return { p, log };
    };
    const shown = p => p.evaluate(() => [...document.querySelectorAll('#admin-subtabs a')].filter(a => a.offsetParent !== null && getComputedStyle(a).display !== 'none').map(a => a.textContent.replace(/\s+\d+$/, '').trim()));
    const { p, log } = await asSec();
    await p.goto(BOARD + '/club/admin/members.html#households', { waitUntil: 'networkidle0', timeout: 45000 });
    await settle(800);
    const t1 = await shown(p);
    await p.evaluate(() => { location.hash = '#renewals'; });
    await settle(600);
    const t2 = await shown(p);
    check('CC7: a Secretary\'s Members tabs leave out Signups and Keyfobs & Access, also after switching to Renewals',
      t1.length === 3 && t2.length === 3 && ![...t1, ...t2].some(t => /Signups|Keyfobs/.test(t)), JSON.stringify({ t1, t2 }));
    await p.goto(BOARD + '/club/admin/board.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await settle(800);
    const t3 = await shown(p);
    check('CC7: Settings → Board\'s tabs leave out Settings and Plan for them', t3.includes('Board') && !t3.includes('Settings') && !t3.includes('Plan'), JSON.stringify(t3));
    await p.goto(BOARD + '/club/admin/', { waitUntil: 'networkidle0', timeout: 45000 });
    await settle(900);
    const su = await p.evaluate(() => {
      const btn = document.querySelector('#setup-card [data-skip="self_signup"]');
      const row = btn && btn.closest('#setup-card > div > div, #setup-card [class]') ? btn.parentElement.parentElement : null;
      const label = row ? [...row.querySelectorAll('div')].find(d => /Sign up your own family/.test(d.textContent) && d.children.length >= 1) : null;
      return { text: label ? Math.round(label.getBoundingClientRect().width) : 0, wide: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    check('CC7: the setup list\'s "Sign up your own family" reads across at phone width (its buttons go under it)', su.text >= 180 && su.wide <= 1, JSON.stringify(su));
    check('CC7: no page errors', !log.errors.length, log.errors.join('; '));
    await p.close();
  }
  await browser.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

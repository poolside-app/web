#!/usr/bin/env node
// The President's look-only preview of a board member's board (PLAN.md CC).
// Doug 11/6: "is there a way i can see each board members board page as i
// have selected their options..? just a view somehow?" He picked opening
// their real board home, look only, President only.
//
// Offline: the rules in _shared/board_view.ts, the functions' wiring, and in
// Chrome the Board page's button and the preview home (every call answered
// by the demo club, scripts/demo_video/data.mjs). Costs nothing.
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

console.log('CC1 · the look-only sign-in (_shared/board_view.ts)');
let bv = null;
try { bv = await importTs(new URL('supabase/functions/_shared/board_view.ts', root)); }
catch (e) { check('_shared/board_view.ts loads', false, String(e.message).slice(0, 120)); }
if (bv) {
  check('its own kind, board_view, for an hour', bv.VIEW_KIND === 'board_view' && bv.VIEW_SECONDS === 3600);
  check('only the board home\'s reads are open to it', JSON.stringify(bv.VIEW_READS) === JSON.stringify({
    tenant_admin_auth: ['me'], admin_tasks: ['home', 'list', 'count'], tenant_settings: ['setup_status'] }), JSON.stringify(bv.VIEW_READS));
  const no = [['admin_tasks', 'complete'], ['admin_tasks', 'dismiss'], ['tenant_admin_auth', 'handoff'], ['tenant_admin_auth', 'view_as'],
    ['tenant_admin_auth', 'invite_admin'], ['gate_admin', 'board_unlock'], ['push_admin', 'subscribe'], ['tenant_settings', 'save'],
    ['applications', 'approve'], ['payment_plans', 'approve'], ['admin_tasks', 'toString'], ['__proto__', 'me'], ['', '']];
  check('everything else is refused (approve, unlock, pop-ups, hand-off, settings…)', no.every(([f, a]) => !bv.viewAllowed(f, a)),
    no.filter(([f, a]) => bv.viewAllowed(f, a)).join(' '));
  check('the reads it needs are allowed', [['tenant_admin_auth', 'me'], ['admin_tasks', 'home'], ['admin_tasks', 'list'], ['tenant_settings', 'setup_status']].every(([f, a]) => bv.viewAllowed(f, a)));
  const c = bv.viewClaims({ target: 'u-erik', tid: 't1', slug: 'maple', by: 'u-sam', byName: 'Sam Brooks', nowSec: 1000 });
  check('the sign-in names who it\'s for and who\'s looking', c.kind === 'board_view' && c.sub === 'u-erik' && c.tid === 't1' && c.slug === 'maple'
    && c.by === 'u-sam' && c.by_name === 'Sam Brooks' && c.exp === 4600 && !('scopes' in c) && !('role_template' in c), JSON.stringify(c));
  check('a real board sign-in is not a preview, nor one missing who\'s looking', !bv.asView({ ...c, kind: 'tenant_admin' }) && !bv.asView({ ...c, by: '' })
    && !bv.asView({ ...c, by: c.sub }) && !bv.asView(null) && bv.asView(c)?.sub === 'u-erik');
  const me = { id: 'u-sam', tid: 't1', isOwner: true };
  const erik = { id: 'u-erik', tenant_id: 't1', active: true, role_template: 'custom' };
  check('the President can see a board member\'s view', bv.canPreview(me, erik) === null, bv.canPreview(me, erik));
  check('…not anyone else', !!bv.canPreview({ ...me, isOwner: false }, erik));
  check('…not another club\'s, a removed one, a gate login, or their own', [
    { ...erik, tenant_id: 't2' }, { ...erik, active: false }, { ...erik, role_template: 'gate_attendant' }, { ...erik, id: 'u-sam' }, null,
  ].every(t => typeof bv.canPreview(me, t) === 'string'));
}

console.log('CC1 · the functions');
{
  const fnDir = new URL('supabase/functions/', root);
  const fns = readdirSync(fnDir).filter(d => d !== '_shared' && existsSync(new URL(`${d}/index.ts`, fnDir)));
  const src = Object.fromEntries(fns.map(d => [d, read(`supabase/functions/${d}/index.ts`)]));
  const unchecked = fns.filter(d => /await verify\(/.test(src[d]) && !/\bkind\s*(!==|===)\s*['"]/.test(src[d]));
  check('every function that reads a sign-in checks its kind, so a preview can do nothing by default', !unchecked.length, unchecked.join(', '));
  const users = fns.filter(d => /board_view/.test(src[d])).sort();
  check('only the three with the board home\'s reads take a preview', JSON.stringify(users) === JSON.stringify(['admin_tasks', 'tenant_admin_auth', 'tenant_settings']), users.join(', '));
  const auth = src.tenant_admin_auth || '';
  const gate = between(auth, 'Auth required for everything below', "action === 'handoff'");
  check('tenant_admin_auth refuses a preview everything but me, before any other step, with 403', /asView\(/.test(gate) && /viewAllowed\('tenant_admin_auth', action\)/.test(gate) && /LOOK_ONLY/.test(gate) && /403/.test(gate), gate.slice(0, 200));
  const meSrc = between(auth, "if (action === 'me')", "action === 'change_password'");
  check('me answers as them, never renews a preview into a real sign-in, and says who\'s looking', /!payload\.viewing_by/.test(between(meSrc, 'let renewed_token', 'return jsonResponse')) && /viewing:/.test(meSrc));
  const va = between(auth, "action === 'view_as'", "\n  if (action === '");
  check('view_as: the President only, by the club\'s own rules, an hour', /requireOwner\(/.test(va) && /canPreview\(/.test(va) && /viewClaims\(/.test(va) && /tenant_id/.test(va), va.slice(0, 160));
  check('a preview is never handed off to a Home Screen app', /viewing_by/.test(between(auth, "action === 'handoff'", 'return jsonResponse({ ok: true, token: tok')));
  for (const fn of ['admin_tasks', 'tenant_settings']) {
    const s = src[fn] || '';
    const head = s.slice(s.indexOf('Deno.serve'), s.indexOf("action === '", s.indexOf('Deno.serve')));
    check(`${fn} refuses a preview anything but its reads, with 403, before any work`, /asView\(/.test(head) && new RegExp(`viewAllowed\\('${fn}', action\\)`).test(head) && /LOOK_ONLY/.test(head) && /403/.test(head), head.slice(-300));
  }
}

console.log('CC2–CC4 · in Chrome');
{
  const page0 = read('club/admin/index.html'), boardPage = read('club/admin/board.html'), flags = read('js/admin-flags.js');
  check('the board home loads board-view.js before anything else', /<head>[\s\S]*?<script src="\/js\/board-view\.js"><\/script>/.test(page0)
    && page0.indexOf('/js/board-view.js') < page0.indexOf('<script', page0.indexOf('<head>')) + 5 + 60, '');
  check('any other board page in a preview tab goes back to it', /poolside_view_token/.test(flags));
  const VIEW = 'VIEWTOKEN.erik';
  const ERIK = { id: 'adm-larsen', email: 'facilities@example.com', display_name: 'Erik Larsen', is_super: false, is_default_pw: true, active: true,
    scopes: ['keyfobs', 'events'], role_template: 'custom', roles: ['custom'], linked_member_id: 'hh-1', member_apply_dismissed: true,
    board_title: 'Facilities Director', impersonated: false, viewing: { by_name: 'Sam Brooks' } };
  const browser = await launch();
  const calls = [];
  const answer = (fn, body, ctx) => {
    if (fn === 'tenant_admin_auth' && body.action === 'view_as') return body.admin_id === 'adm-larsen' ? { ok: true, token: VIEW } : { ok: false, error: 'no' };
    if (fn === 'tenant_admin_auth' && body.action === 'me' && ctx.viewing) { const m = respond(fn, body, ctx); return { ...m, user: ERIK }; }
    return siteRespond(fn, body, ctx) ?? respond(fn, body, ctx);
  };
  const watch = page => page.on('request', r => {
    const m = r.url().match(/functions\/v1\/([a-z_]+)/); if (!m || r.method() !== 'POST') return;
    let a = ''; try { a = JSON.parse(r.postData() || '{}').action || ''; } catch { /* not json */ }
    calls.push({ fn: m[1], action: a, view: (r.headers().authorization || '') === `Bearer ${VIEW}` });
  });
  const open = async (path, viewing) => {
    const p = await browser.newPage();
    await p.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1');
    await p.setViewport({ width: 390, height: 844 });
    const ctx = { viewing };
    const log = await attach(p, { state: {}, answer: (fn, body, c) => answer(fn, body, { ...c, viewing: ctx.viewing }) });
    watch(p);
    return { p, log, ctx };
  };

  // CC2: the Board page's button.
  {
    const { p, log } = await open();
    await p.goto(BOARD + '/club/admin/board.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(r => setTimeout(r, 600));
    const rows = await p.evaluate(() => [...document.querySelectorAll('#members .mrow')].map(r => ({ name: r.querySelector('.nm')?.textContent || '', see: !!r.querySelector('[data-see]') })));
    check('CC2: "See their view" beside each board member but you', rows.length === 3 && rows.filter(r => r.see).length === 2 && !rows.find(r => /\(you\)/.test(r.name))?.see, JSON.stringify(rows));
    await p.evaluate(() => { const b = document.querySelector('#members [data-see="adm-larsen"]'); if (b) b.click(); });
    await p.waitForNavigation({ timeout: 8000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    check('CC2: tapping it asks for their look-only sign-in and opens their home in this tab', calls.some(c => c.fn === 'tenant_admin_auth' && c.action === 'view_as')
      && new URL(p.url()).pathname === '/club/admin/', p.url());
    check('CC2: no page errors', !log.errors.length, log.errors.join('; '));
    await p.close();
  }

  // CC3: the preview home.
  calls.length = 0;
  {
    const { p, log, ctx } = await open();
    await p.goto(BOARD + '/robots.txt').catch(() => {});
    // Your own board sign-in in this browser (the harness signs the demo board in on every page).
    await p.evaluate(() => localStorage.setItem('keep_me', '1'));
    const realBefore = await p.evaluate(() => ({ t: localStorage.getItem('poolside_tenant_token'), u: localStorage.getItem('poolside_tenant_user'), k: localStorage.getItem('keep_me') }));
    ctx.viewing = true;
    await p.goto(BOARD + '/club/admin/#view=' + encodeURIComponent(VIEW), { waitUntil: 'networkidle0', timeout: 45000 });
    await new Promise(r => setTimeout(r, 1000));
    const st = await p.evaluate(() => ({
      bar: document.getElementById('board-view-bar')?.innerText || '', hash: location.hash, path: location.pathname,
      tabs: [...document.querySelectorAll('#btabs [data-btab]')].map(a => a.dataset.btab),
    }));
    check('CC2: the bar says whose view it is and that it\'s look only', /Viewing as Erik Larsen/.test(st.bar) && /Facilities Director/.test(st.bar) && /Look only/i.test(st.bar), st.bar);
    check('CC3: the sign-in is gone from the address', st.hash === '' && st.path === '/club/admin/', st.hash);
    check('CC2: their bottom bar: Home, their sections, More (no Money or Settings)', st.tabs[0] === 'home' && st.tabs.includes('members') && st.tabs.includes('calendar')
      && !st.tabs.includes('money') && !st.tabs.includes('settings'), st.tabs.join(','));
    const viewCalls = calls.filter(c => c.view);
    check('CC3: every call it made is a board home read', viewCalls.length >= 2 && viewCalls.every(c => bv && bv.viewAllowed(c.fn, c.action)), JSON.stringify(viewCalls));
    check('CC3: it never used your own sign-in', !calls.some(c => !c.view && ['tenant_admin_auth', 'admin_tasks', 'tenant_settings', 'push_admin', 'gate_admin'].includes(c.fn)), JSON.stringify(calls.filter(c => !c.view)));
    // Anything else stops before it leaves the phone.
    const before = calls.length;
    const res = await p.evaluate(async v => {
      const r = await fetch('https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/admin_tasks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + v }, body: JSON.stringify({ action: 'complete', id: 't1' }) });
      return { status: r.status, body: await r.json() };
    }, VIEW);
    check('CC3: a change (marking a to-do done) is stopped on the phone with "look only"', res.status === 403 && /look-only/i.test(res.body.error || '') && calls.length === before, JSON.stringify(res));
    // Leaving their home shows what they can open instead.
    await p.evaluate(() => { const a = document.querySelector('#btabs [data-btab="members"]'); if (a) a.click(); });
    await new Promise(r => setTimeout(r, 400));
    const sheet = await p.evaluate(() => ({ text: document.getElementById('board-view-screens')?.innerText || '', path: location.pathname }));
    check('CC4: tapping a tab shows "Erik can open:" with their sections and tabs, staying on their home', sheet.path === '/club/admin/' && /Erik can open/.test(sheet.text)
      && /Keyfobs/.test(sheet.text) && /Events/.test(sheet.text) && !/Payments/.test(sheet.text), sheet.text.slice(0, 200));
    check('CC3: no page errors', !log.errors.length, log.errors.join('; '));
    // Your own sign-in, seen from another tab, is untouched.
    const other = await browser.newPage();
    await attach(other, { state: {} });
    await other.goto(BOARD + '/robots.txt').catch(() => {});
    const real = await other.evaluate(() => ({ t: localStorage.getItem('poolside_tenant_token'), u: localStorage.getItem('poolside_tenant_user'), k: localStorage.getItem('keep_me') }));
    check('CC3: your own sign-in and saved things are untouched', !!realBefore.t && real.t === realBefore.t && real.u === realBefore.u && real.k === '1' && real.t !== VIEW, JSON.stringify(real));
    await other.close();
    // Another board page in this tab goes back to the preview.
    ctx.viewing = true;
    await p.goto(BOARD + '/club/admin/payments.html', { waitUntil: 'networkidle0', timeout: 45000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    check('CC4: another board page opened in the preview tab goes back to their home', new URL(p.url()).pathname === '/club/admin/', p.url());
    // Close.
    await p.evaluate(() => { const b = document.querySelector('#board-view-bar [data-close]'); if (b) b.click(); });
    await p.waitForNavigation({ timeout: 8000 }).catch(() => {});
    const after = await p.evaluate(() => ({ path: location.pathname, view: sessionStorage.getItem('poolside_view_token'), t: localStorage.getItem('poolside_tenant_token') }));
    check('CC2: Close ends the preview and goes back to Settings → Board, signed in as you', after.path === '/club/admin/board.html' && !after.view && after.t === realBefore.t, JSON.stringify(after));
    await p.close();
  }
  await browser.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

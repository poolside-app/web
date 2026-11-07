#!/usr/bin/env node
// The club setup list goes to whoever handles setup (PLAN.md CD).
// Doug 11/6: "That list of setup should only be president or maybe we have an
// accisible tab for poolside onboarding setup? We can select who deals with
// the setup… might not always be the president". His picks: a "Club setup"
// alert on a position you choose, the list on their home plus a Setup tab.
//
// Offline: the alert and who it goes to, the steps each person gets
// (_shared/setup_person.ts), the wiring, and in Chrome the home, the Setup
// tab and the Board page (calls answered by the demo club). Costs nothing.
//
// Usage: node scripts/test_setup_person.mjs
import { readFileSync } from 'node:fs';
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
const settle = ms => new Promise(r => setTimeout(r, ms));

console.log('CD1 · the Club setup alert');
const pos = await importTs(new URL('supabase/functions/_shared/positions.ts', root));
let sp = null;
try { sp = await importTs(new URL('supabase/functions/_shared/setup_person.ts', root)); }
catch (e) { check('_shared/setup_person.ts loads', false, String(e.message).slice(0, 120)); }
check('a "Club setup" alert positions can be given, which brings the Policies screen its step needs', !!pos.NOTICES.setup && /setup/i.test(pos.NOTICES.setup.label)
  && JSON.stringify(pos.NOTICES.setup.needs) === '["policies"]', JSON.stringify(pos.NOTICES.setup));
const P = (id, slug, title, notices = [], extra = {}) => ({ id, slug, title, notices, scopes: [], sort: 0, ...extra });
const positions = [P('p-pres', 'president', 'President', [], { full_access: true }), P('p-vp', 'vice_president', 'Vice-President'), P('p-sec', 'secretary', 'Secretary')];
const logins = [{ id: 'u-doug', active: true, role_template: 'owner', roles: ['owner'] }, { id: 'u-pat', active: true, role_template: 'custom', roles: ['custom'] }];
const holders = [{ position_id: 'p-pres', admin_user_id: 'u-doug' }, { position_id: 'p-sec', admin_user_id: 'u-pat' }];
if (sp) {
  const b0 = { positions, holders, logins };
  check('nobody given it: the President handles setup (Bishop today)', sp.handlesSetup('u-doug', b0) && !sp.handlesSetup('u-pat', b0));
  const b1 = { positions: positions.map(p => p.id === 'p-sec' ? { ...p, notices: ['setup'] } : p), holders, logins };
  check('given to the Secretary: they handle it, not the President', sp.handlesSetup('u-pat', b1) && !sp.handlesSetup('u-doug', b1));
  check('who handles it, by position', sp.setupWho(b0) === 'President' && sp.setupWho(b1) === 'Secretary', `${sp.setupWho(b0)} / ${sp.setupWho(b1)}`);
}

console.log('CD2 · the steps each person gets');
const LABEL = { logo: 'Upload your club logo', hero: 'Write your front-page headline', address: 'Enter your club\'s address', location: 'Set your pool location and hours',
  prices: 'Set your membership prices', payment: 'Choose how members pay', policies: 'Add your policies and waiver', self_signup: 'Sign up your own family',
  invite_board: 'Set up your board positions', share_link: 'Share your join link with members' };
const ITEMS = [
  ['logo', true], ['hero', true], ['address', false], ['location', true], ['prices', true], ['payment', true], ['policies', false],
  ['self_signup', false], ['invite_board', false], ['share_link', true],
].map(([id, done]) => ({ id, label: LABEL[id], done, fix_url: '#' + id, fix_label: 'Go' }));
if (sp) {
  check('seven steps need full access to save', JSON.stringify([...sp.FULL_ACCESS_STEPS].sort()) === JSON.stringify(['address', 'hero', 'invite_board', 'location', 'logo', 'payment', 'prices']));
  const a = sp.setupFor(ITEMS, { mine: true, fullAccess: true });
  check('the setup person with full access: every step, with buttons', a.mine === true && a.items.length === 10 && !a.items.some(i => i.needs_full) && a.done === 6 && a.total === 10 && !a.complete, JSON.stringify(a).slice(0, 200));
  const b = sp.setupFor(ITEMS, { mine: true, fullAccess: false });
  check('the setup person without it: every step, the ones left that need it marked', b.items.length === 10 && JSON.stringify(b.items.filter(i => i.needs_full).map(i => i.id).sort()) === '["address","invite_board"]'
    && !b.items.find(i => i.id === 'policies').needs_full, JSON.stringify(b.items.filter(i => i.needs_full)));
  const c = sp.setupFor(ITEMS, { mine: false, fullAccess: false });
  check('everyone else: only their own step, Sign up your own family', c.mine === false && c.items.length === 1 && c.items[0].id === 'self_signup' && c.total === 1 && !c.complete, JSON.stringify(c));
  const d = sp.setupFor(ITEMS.map(i => i.id === 'self_signup' ? { ...i, done: true } : i), { mine: false, fullAccess: false });
  check('…and nothing once that\'s done', d.complete === true);
  const e = sp.setupFor(ITEMS, { mine: false, fullAccess: true });
  check('full access but not handling it: the whole list for the Setup tab, not theirs to do', e.mine === false && e.items.length === 10, JSON.stringify({ mine: e.mine, n: e.items.length }));
}
{
  const ts = read('supabase/functions/tenant_settings/index.ts'), auth = read('supabase/functions/tenant_admin_auth/index.ts');
  const st = between(ts, "action === 'setup_status'", "return jsonResponse({ ok: false, error: `Unknown action");
  check('setup_status shapes the list by who handles setup and full access', /setupFor\(/.test(st) && /handlesSetup\(/.test(st) && /setupWho\(/.test(st), st.slice(0, 120));
  check('setup_status works for a look-only preview of a position too', /positionPreview\(/.test(st));
  const meSrc = between(auth, "if (action === 'me')", "action === 'change_password'");
  check('me says whether they handle setup, a position\'s preview included', (meSrc.match(/handles_setup/g) || []).length >= 2 && /handlesSetup\(/.test(meSrc));
  const flags = read('js/admin-flags.js');
  check('the one-line reminder on other pages is only for whoever handles setup', /data\.mine/.test(between(flags, 'async function paintSetupBanner', '\n  }\n')));
  const nav = read('js/admin-subtabs.js');
  check('CD3: a Setup tab under Settings, for whoever handles setup and full access', /key: 'setup'[^}]*href: '\/club\/admin\/setup\.html'[^}]*setup: true/.test(nav) && /item\.setup/.test(nav) && /handles_setup/.test(nav) && /'setup\.html': 'settings'/.test(nav));
  const help = read('club/admin/help/articles/getting-started.md');
  check('Getting started says who sees the list and where the tab is', /Club setup/.test(help) && /\*\*Settings → Setup\*\*/.test(help));
}

console.log('CD1–CD3 · in Chrome');
{
  const browser = await launch();
  const user = (extra) => ({ id: 'u', email: 'x@example.com', display_name: 'Pat Secretary', is_super: false, is_default_pw: false, active: true,
    scopes: ['households', 'events', 'announcements', 'photos', 'policies', 'meetings'], role_template: 'custom', roles: ['custom'],
    linked_member_id: null, member_apply_dismissed: false, board_title: 'Secretary', impersonated: false, handles_setup: false, ...extra });
  const open = async (u, status) => {
    const p = await browser.newPage();
    await p.setViewport({ width: 390, height: 844 });
    const log = await attach(p, { state: {}, answer: (fn, body, c) => {
      if (fn === 'tenant_admin_auth' && body.action === 'me') return { ...respond(fn, body, c), user: u };
      if (fn === 'tenant_settings' && body.action === 'setup_status') return { ok: true, ...status, who: 'President' };
      if (fn === 'board' && body.action === 'get') return { ...siteRespond(fn, body, c), notices: Object.fromEntries(Object.entries(pos.NOTICES).map(([k, v]) => [k, v.label])),
        positions: [{ id: 'p-sec', title: 'Secretary', purpose: '', description: '', notices: [], scopes: [], holders: [], vacant_goes_to: null, full_access: false }] };
      return siteRespond(fn, body, c) ?? respond(fn, body, c);
    } });
    await p.evaluateOnNewDocument(x => { try { localStorage.setItem('poolside_tenant_user', x); } catch (_) {} }, JSON.stringify(u));
    return { p, log };
  };
  const view = p => p.evaluate(() => ({
    card: document.getElementById('setup-card')?.innerText.replace(/\s+/g, ' ') || '',
    banner: document.getElementById('setup-banner')?.innerText || '',
    tabs: [...document.querySelectorAll('#admin-subtabs a')].filter(a => a.offsetParent !== null).map(a => a.textContent.trim()),
  }));
  if (sp) {
    // A Secretary who doesn't handle setup.
    {
      const { p, log } = await open(user(), sp.setupFor(ITEMS, { mine: false, fullAccess: false }));
      await p.goto(BOARD + '/club/admin/', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(900);
      const h = await view(p);
      check('CD2: a Secretary\'s home: only "Sign up your own family", no setup list', /Sign up your own family/.test(h.card) && !/Setup: \d+ of/.test(h.card) && !/club logo/i.test(h.card), h.card.slice(0, 160));
      await p.goto(BOARD + '/club/admin/events.html', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(900);
      const e = await view(p);
      check('CD2: no setup reminder on their other pages', !e.banner, e.banner);
      await p.goto(BOARD + '/club/admin/board.html', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(800);
      const b = await view(p);
      check('CD3: no Setup tab for them', !b.tabs.includes('Setup') && b.tabs.includes('Board'), JSON.stringify(b.tabs));
      check('CD2: no page errors', !log.errors.length, log.errors.join('; '));
      await p.close();
    }
    // The Secretary handling setup, without full access.
    {
      const u = user({ handles_setup: true });
      const { p, log } = await open(u, sp.setupFor(ITEMS, { mine: true, fullAccess: false }));
      await p.goto(BOARD + '/club/admin/', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(900);
      const h = await view(p);
      check('CD2: the setup person\'s home has the whole list', /Setup: 6 of 10 done/.test(h.card) && /address/.test(h.card) && /policies/.test(h.card), h.card.slice(0, 200));
      const marks = await p.evaluate(() => [...document.querySelectorAll('#setup-card [data-needs-full]')].map(e => e.dataset.needsFull));
      check('CD2: the steps they can\'t save are marked', JSON.stringify(marks.sort()) === '["address","invite_board"]', JSON.stringify(marks));
      const btns = await p.evaluate(() => ({ addr: !!document.querySelector('#setup-card a[data-setup="address"]'), pol: !!document.querySelector('#setup-card a[data-setup="policies"]'),
        text: document.querySelector('#setup-card [data-needs-full="address"]')?.textContent || '' }));
      check('CD2: …while the steps they can do keep their buttons', !btns.addr && btns.pol && /Needs full access/.test(btns.text) && /President/.test(btns.text), JSON.stringify(btns));
      await p.goto(BOARD + '/club/admin/events.html', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(900);
      check('CD2: their other pages keep the one-line reminder', /Setup: 6 of 10/.test((await view(p)).banner));
      await p.goto(BOARD + '/club/admin/setup.html', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(900);
      const s = await p.evaluate(() => ({ path: location.pathname, text: document.getElementById('setup-list')?.innerText.replace(/\s+/g, ' ') || '',
        fold: !!document.querySelector('#setup-list #setup-fold'), tabs: [...document.querySelectorAll('#admin-subtabs a')].filter(a => a.offsetParent !== null).map(a => a.textContent.trim()),
        wide: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
      check('CD3: no one-line reminder on the Setup tab itself', !(await view(p)).banner);
      check('CD3: the Setup tab has the whole list, always open, in Settings\' tabs', s.path === '/club/admin/setup.html' && /6 of 10/.test(s.text) && /self_signup|Sign up/.test(s.text) && !s.fold && s.tabs.includes('Setup') && s.wide <= 1, JSON.stringify(s).slice(0, 260));
      check('CD3: no page errors', !log.errors.length, log.errors.join('; '));
      await p.close();
    }
    // Someone else reaching the Setup tab.
    {
      const { p, log } = await open(user(), sp.setupFor(ITEMS, { mine: false, fullAccess: false }));
      await p.goto(BOARD + '/club/admin/setup.html', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(900);
      const t = await p.evaluate(() => document.getElementById('setup-list')?.innerText.replace(/\s+/g, ' ') || '');
      check('CD3: anyone else there sees who handles setup and their own step', /President handles the club.s setup/.test(t) && /Sign up your own family/.test(t) && !/club logo/i.test(t), t.slice(0, 200));
      check('CD3: no page errors (someone else)', !log.errors.length, log.errors.join('; '));
      await p.close();
    }
    // The Board page: the alert, and the full-access note.
    {
      const { p, log } = await open(user({ role_template: 'owner', roles: ['owner'], scopes: [] }), sp.setupFor(ITEMS, { mine: true, fullAccess: true }));
      await p.goto(BOARD + '/club/admin/board.html', { waitUntil: 'networkidle0', timeout: 45000 });
      await settle(700);
      await p.evaluate(() => editPosition('p-sec'));
      await settle(200);
      const before = await p.evaluate(() => ({ alert: !!document.querySelector('#pos-notices input[value="setup"]'), hint: !document.getElementById('pos-setup-hint')?.hidden }));
      await p.evaluate(() => { const c = document.querySelector('#pos-notices input[value="setup"]'); if (c) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); } });
      const ticked = await p.evaluate(() => ({ hint: !document.getElementById('pos-setup-hint')?.hidden, text: document.getElementById('pos-setup-hint')?.textContent || '' }));
      await p.evaluate(() => { const f = document.getElementById('pos-full'); f.checked = true; f.dispatchEvent(new Event('change', { bubbles: true })); });
      const full = await p.evaluate(() => !document.getElementById('pos-setup-hint')?.hidden);
      check('CD1: the position editor lists the Club setup alert', before.alert, JSON.stringify(before));
      check('CD2: ticking it on a position without full access says most steps need it; with full access it doesn\'t', !before.hint && ticked.hint && /full access/i.test(ticked.text) && !full, JSON.stringify({ before, ticked, full }));
      check('CD1: no page errors (Board)', !log.errors.length, log.errors.join('; '));
      await p.close();
    }
  }
  await browser.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

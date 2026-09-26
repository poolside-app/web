// Phone-sized render checks for scripts/test_screens.mjs --render.
// Serves this checkout's copies of the changed pages on the real club
// address, so it checks what's about to ship. About 15 Edge Function calls.
import puppeteer from 'puppeteer-core';
import { makeTempMember, purgeTestFamilies } from './testdata.mjs';

const HOST = 'https://bishopestates.poolsideapp.com';
const LOCAL = {
  '/apply.html': 'apply.html',
  '/m/': 'm/index.html', '/m/index.html': 'm/index.html', '/m/login.html': 'm/login.html',
  '/club/admin/members.html': 'club/admin/members.html',
  '/': 'club/index.html', '/index.html': 'club/index.html',
  '/club/admin/': 'club/admin/index.html', '/club/admin/index.html': 'club/admin/index.html',
  '/club/admin/payments.html': 'club/admin/payments.html', '/club/admin/settings.html': 'club/admin/settings.html',
  '/club/admin/application.html': 'club/admin/application.html', '/js/upcoming.js': 'js/upcoming.js', '/js/today.js': 'js/today.js', '/js/calendar.js': 'js/calendar.js',
  '/js/admin-subtabs.js': 'js/admin-subtabs.js', '/js/admin-push.js': 'js/admin-push.js',
  '/js/upcoming.js': 'js/upcoming.js', '/js/admin-help-fab.js': 'js/admin-help-fab.js', '/js/admin-flags.js': 'js/admin-flags.js',
};

// RENDER_ONLY=apply,login,members,home limits the run to those pages.
const ONLY = (process.env.RENDER_ONLY || '').split(',').map(x => x.trim()).filter(Boolean);
const want = page => !ONLY.length || ONLY.includes(page);

export async function renderChecks({ check, read, sql, jwt }) {
  console.log('\nRendered at phone size' + (ONLY.length ? ` (${ONLY.join(', ')})` : ''));
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'],
  });
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
  const FAMILY = `SimTest render ${String(Date.now()).slice(-6)}`;

  async function open(path, store = {}) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await p.emulateTimezone('America/New_York');
    await p.evaluateOnNewDocument(s => { if (!sessionStorage.getItem('seeded')) { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); sessionStorage.setItem('seeded', '1'); } }, store);
    await p.setRequestInterception(true);
    p.on('request', r => {
      const u = new URL(r.url());
      if (u.origin === HOST && LOCAL[u.pathname]) {
        return r.respond({ status: 200, contentType: u.pathname.endsWith('.js') ? 'application/javascript' : 'text/html', body: read(LOCAL[u.pathname]) });
      }
      r.continue();
    });
    p.errs = [];
    p.on('pageerror', e => p.errs.push(e.message));
    p.on('dialog', d => { p.errs.push('browser pop-up: ' + d.message()); d.dismiss(); });
    await p.goto(HOST + path, { waitUntil: 'networkidle2', timeout: 60000 });
    return p;
  }
  const wait = ms => new Promise(r => setTimeout(r, ms));

  try {
    if (want('apply')) {
    // D1: one error, under the field
    const a = await open('/apply.html');
    await a.evaluate(() => { const b = document.getElementById('next-btn'); b && b.click(); });
    await wait(300);
    const errs = await a.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(el => el.children.length === 0 && /Your name is required/.test(el.textContent) && el.offsetParent).length);
    const under = await a.evaluate(() => document.getElementById('your_name')?.nextElementSibling?.className === 'field-err');
    check('D1: an empty signup step shows its error once, under the field', errs === 1 && under, `shown ${errs} times, under field: ${under}`);
    check('D1: no page errors', a.errs.length === 0, a.errs.join(' | '));

    // H1: name once on page 1 → last name and Adult #1
    await a.type('#your_name', 'Jamie Rivera');
    const fam = await a.$eval('#family_name', el => el.value);
    await a.evaluate(() => { for (const [id, v] of [['address', '1 Main St'], ['primary_phone', '(925) 555-0100'], ['primary_email', 'jamie@example.com'], ['emergency_name', 'Pat Rivera'], ['emergency_phone', '(925) 555-0101']]) document.getElementById(id).value = v; });
    await a.evaluate(() => document.getElementById('next-btn').click());
    await wait(300);
    const adult1 = await a.evaluate(() => document.querySelector('[data-adult="0"][data-field="name"]')?.value);
    check('H1: "Your name" fills the last name and Adult #1', fam === 'Rivera' && adult1 === 'Jamie Rivera', `last "${fam}", adult #1 "${adult1}"`);
    // H2: headcount picks the level (unless they chose one). The levels
    // render after the policies load.
    await a.waitForSelector('input[name="tier_slug"]', { timeout: 20000 });
    const pick = await a.evaluate(() => {
      const set = (ad, ch) => { document.getElementById('acount').value = String(ad); document.getElementById('ccount').value = String(ch); applyTierDefault(); return document.querySelector('input[name="tier_slug"]:checked')?.value; };
      return { one: set(1, 0), three: set(2, 1) };
    });
    check('H2: 1 adult → Single, 3 people → Family', pick.one === 'single' && pick.three === 'family', JSON.stringify(pick));
    }

    if (want('login')) {
    // D6/D13: login button and placeholder
    const l = await open('/m/login.html');
    const fits = await l.evaluate(() => {
      const i = document.getElementById('email');
      const cs = getComputedStyle(i);
      const c = document.createElement('canvas').getContext('2d');
      c.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const room = i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      return c.measureText(i.placeholder).width <= room;
    });
    check('D13: the sign-in placeholder fits on a phone', fits);
    await l.type('#email', '(925) 555-0142');
    const phoneLabel = await l.$eval('#submit', b => b.textContent.trim());
    await l.evaluate(() => { const i = document.getElementById('email'); i.value = ''; i.dispatchEvent(new Event('input')); });
    await l.type('#email', 'pat@example.com');
    const emailLabel = await l.$eval('#submit', b => b.textContent.trim());
    check('D13: the button says Text me a code / Email me a link', phoneLabel === 'Text me a code' && emailLabel === 'Email me a link', `${phoneLabel} / ${emailLabel}`);
    await l.evaluate(() => { const i = document.getElementById('email'); i.value = ''; i.dispatchEvent(new Event('input')); });
    await l.type('#email', '9257719074');
    const formatted = await l.$eval('#email', el => el.value);
    check('H3: a typed number shows as (925) 771-9074', formatted === '(925) 771-9074', formatted);
    // A number that isn't on file (fake 555 exchange, so nothing is sent):
    // the page must not say "open the email", and must offer the code box.
    await l.evaluate(() => { const i = document.getElementById('email'); i.value = ''; i.dispatchEvent(new Event('input')); });
    await l.type('#email', '(555) 010-9999');
    await l.click('#submit');
    await l.waitForFunction(() => document.getElementById('ok').classList.contains('show') || document.getElementById('err').classList.contains('show'), { timeout: 20000 });
    const unknown = await l.evaluate(() => ({
      ok: document.getElementById('ok').innerText, err: document.getElementById('err').innerText,
      codeBox: getComputedStyle(document.getElementById('code-box')).display !== 'none',
    }));
    check('D6: a number not on file gets "if your number is on file", the code box and a Join link',
      /text/i.test(unknown.ok) && !/open the email/i.test(unknown.ok) && /Not a member yet/.test(unknown.ok) && unknown.codeBox,
      JSON.stringify(unknown).slice(0, 220));
    }

    if (want('board')) {
    // Board pages load clean for the president (every page the trim and
    // the consolidation touched).
    const tok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    for (const path of ['/club/admin/', '/club/admin/payments.html', '/club/admin/settings.html', '/club/admin/application.html', '/club/admin/members.html']) {
      const pg = await open(path, { poolside_tenant_token: tok });
      await wait(2000);
      if (path === '/club/admin/') {
        // J1: the one checklist, with its 9 items, each linking to a real screen.
        const setup = await pg.evaluate(() => {
          const card = document.getElementById('setup-card');
          if (!card) return { shown: false };
          if (!card.querySelector('[data-setup]') && /Setup: \d+ of 9/.test(card.innerText)) return { shown: true, folded: true };
          return { shown: true, rows: card.querySelectorAll('div[style*="border:1px solid #fde68a"]').length,
            links: [...card.querySelectorAll('a[data-setup]')].map(a => a.getAttribute('href')) };
        });
        check('J1: the dashboard shows the one checklist (9 items, real screens)',
          setup.shown && (setup.folded || (setup.rows === 9 && setup.links.every(h => !/wizard|setup\.html/.test(h)))), JSON.stringify(setup).slice(0, 220));
      }
      const url = new URL(pg.url()).pathname;
      check(`board: ${path} loads with no errors`, pg.errs.filter(e => !/browser pop-up/.test(e)).length === 0 && !/login/.test(url),
        `${url} ${pg.errs.join(' | ').slice(0, 200)}`);
    }
    }

    if (want('public')) {
    // The public club page after the trim (I1, I2): loads clean, no
    // anonymous feedback and no campaign pop-up.
    const pub = await open('/');
    await pub.waitForSelector('#root', { timeout: 20000 });
    await wait(1500);
    const txt = await pub.evaluate(() => document.body.innerText);
    check('public page: loads with no errors, no anonymous feedback', pub.errs.length === 0 && !/anonymous feedback/i.test(txt), pub.errs.join(' | '));
    }

    const m = await makeTempMember(sql, club.id, FAMILY);
    if (want('members')) {
    // D12: Members list fits a phone (with at least one family in it)
    const ownerTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    const mem = await open('/club/admin/members.html#households', { poolside_tenant_token: ownerTok });
    await mem.waitForSelector('#hh-card table, #hh-card .empty', { timeout: 20000 });
    await wait(500);
    const fit = await mem.evaluate(() => {
      const c = document.getElementById('hh-card');
      const row = c.querySelector('tbody tr');
      return { overflow: c.scrollWidth - c.clientWidth, cards: row ? getComputedStyle(row).display : 'none', pad: getComputedStyle(document.body).paddingBottom };
    });
    check('D12: the households list fits the screen as cards', fit.overflow <= 1 && fit.cards === 'grid', JSON.stringify(fit));
    check('D12: room under the list for the Help button', fit.pad === '76px', fit.pad);
    await mem.screenshot({ path: '/tmp/poolside-members-phone.png' });
    }

    if (want('home')) {
    // D3/D8/D9/D4: member home
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: m.household_id });
    const h = await open('/m/', { poolside_member_token: memTok });
    await h.waitForSelector('.hero-card', { timeout: 30000 });
    await wait(2500);   // the calendar feeds load after the page
    const first = await h.$eval('.hero-card .sub', el => el.textContent.trim());
    const order = await h.evaluate(() => {
      const fam = document.querySelector('a[href="/m/family.html"].card'), today = document.getElementById('today-block');
      return fam && today ? !!(fam.compareDocumentPosition(today) & Node.DOCUMENT_POSITION_FOLLOWING) : null;
    });
    const coming = await h.$eval('#coming-up', el => el.innerText.replace(/\s+/g, ' '));
    check('D3: a first visit says "Welcome to"', /^Welcome to /.test(first), first);
    check('D8: the family and dues card is above Today', order === true, String(order));
    const trimmed = await h.evaluate(() => ({
      feedback: /anonymous feedback/i.test(document.body.innerText),
      popup: !!document.querySelector('.campaign-popup-host'),
      count: /\d+ households? · \d+ members?/.test(document.querySelector('.hero-card')?.innerText || ''),
    }));
    check('I: member home has no feedback card, pop-up or member-count line', !trimmed.feedback && !trimmed.popup && !trimmed.count, JSON.stringify(trimmed));
    check('D9: "Coming up" doesn\'t list the daily Pool Open', !/Pool Open/.test(coming), coming.slice(0, 160));
    const picking = h.evaluate(() => pickFamilyMember('Who\'s signing up for Swim lessons?'));
    await wait(300);
    const pick = await h.$eval('#ask-scrim', el => ({ open: el.classList.contains('open'), text: el.innerText.replace(/\s+/g, ' ') }));
    await h.screenshot({ path: '/tmp/poolside-pick-family.png' });
    const cancelColor = await h.$eval('#ask-no', b => getComputedStyle(b).color);
    const uploadColor = await h.evaluate(() => {
      const b = [...document.querySelectorAll('.card .btn-ghost')].find(x => /Upload a photo/.test(x.textContent));
      return b ? getComputedStyle(b).color : 'missing';
    });
    check('D4: Cancel and card buttons are visible (not white on white)',
      cancelColor !== 'rgb(255, 255, 255)' && uploadColor !== 'rgb(255, 255, 255)', `cancel ${cancelColor}, upload ${uploadColor}`);
    await h.click('#ask-no');
    await picking;
    check('D4: sign-ups pick from your family in the page', pick.open && pick.text.includes(`${FAMILY} Tester`) && /Someone else/.test(pick.text), pick.text.slice(0, 160));
    await h.reload({ waitUntil: 'networkidle2' });
    await h.waitForSelector('.hero-card', { timeout: 30000 });
    const again = await h.$eval('.hero-card .sub', el => el.textContent.trim());
    check('D3: the next visit says "Welcome back"', /^Welcome back to /.test(again), again);
    check('member home: no page errors or browser pop-ups', h.errs.length === 0, h.errs.join(' | '));
    }
  } finally {
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    await browser.close();
  }
}

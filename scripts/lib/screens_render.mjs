// Phone-sized render checks for scripts/test_screens.mjs --render.
// Serves this checkout's copies of the changed pages on the real club
// address, so it checks what's about to ship. About 15 Edge Function calls.
import puppeteer from 'puppeteer-core';
import { makeTempMember, purgeTestFamilies } from './testdata.mjs';

const HOST = 'https://bishopestates.poolsideapp.com';
const LOCAL = {
  '/apply.html': 'apply.html', '/js/plan-picker.js': 'js/plan-picker.js', '/renew.html': 'renew.html',
  '/m/': 'm/index.html', '/m/index.html': 'm/index.html', '/m/login.html': 'm/login.html',
  '/club/admin/members.html': 'club/admin/members.html',
  '/': 'club/index.html', '/index.html': 'club/index.html',
  '/club/admin/': 'club/admin/index.html', '/club/admin/index.html': 'club/admin/index.html',
  '/club/admin/payments.html': 'club/admin/payments.html', '/club/admin/settings.html': 'club/admin/settings.html',
  '/club/admin/application.html': 'club/admin/application.html', '/js/upcoming.js': 'js/upcoming.js', '/js/today.js': 'js/today.js', '/js/calendar.js': 'js/calendar.js',
  '/js/admin-subtabs.js': 'js/admin-subtabs.js', '/js/admin-push.js': 'js/admin-push.js',
  '/js/upcoming.js': 'js/upcoming.js', '/js/admin-help-fab.js': 'js/admin-help-fab.js', '/js/admin-flags.js': 'js/admin-flags.js',
  '/js/pooltime.js': 'js/pooltime.js', '/club/admin/events.html': 'club/admin/events.html', '/club/admin/member-help.html': 'club/admin/member-help.html', '/js/calendar.js': 'js/calendar.js', '/governance.html': 'governance.html', '/club/admin/board-meetings.html': 'club/admin/board-meetings.html', '/club/admin/board.html': 'club/admin/board.html', '/club/admin/admins.html': 'club/admin/admins.html', '/m/renew.html': 'm/renew.html', '/renew.html': 'renew.html', '/club/index.html': 'club/index.html', '/club/admin/events.html': 'club/admin/events.html',
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

  // `rewrite(action, json)` edits an Edge Function's real answer before the
  // page sees it (used to show the renewal page outside the renewal window).
  async function open(path, store = {}, rewrite = null) {
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
      if (rewrite && /\/functions\/v1\//.test(u.pathname) && r.method() === 'POST') {
        return (async () => {
          const res = await fetch(r.url(), { method: 'POST', headers: r.headers(), body: r.postData() });
          let json = await res.json().catch(() => null);
          try { const body = JSON.parse(r.postData() || '{}'); json = rewrite(body.action, json, body) ?? json; } catch { /* leave it */ }
          r.respond({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(json) });
        })();
      }
      if (r.method() === 'OPTIONS' && rewrite && /\/functions\/v1\//.test(u.pathname)) {
        return r.respond({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, OPTIONS' }, body: 'ok' });
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

    // H5: "Have a code?" checks the code with the server and says why not.
    await a.evaluate(async () => { APPLIED_CODE = 'NOSUCHCODE'; await refreshQuote(); });
    const codeMsg = await a.$eval('#code-msg', el => el.textContent.trim());
    const venmoPrice = await a.$eval('#venmo-price', el => el.textContent.trim());
    check('H5: a wrong code is refused on the signup form, and the price stays', /isn't valid/.test(codeMsg) && /\$\d/.test(venmoPrice), `${codeMsg} | ${venmoPrice}`);
    check('H5: signup form has no page errors', a.errs.length === 0, a.errs.join(' | '));
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
    for (const path of ['/club/admin/', '/club/admin/payments.html', '/club/admin/settings.html', '/club/admin/application.html', '/club/admin/members.html', '/club/admin/board.html', '/club/admin/board-meetings.html', '/club/admin/events.html', '/club/admin/member-help.html']) {
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
        // K4: "Your job" with the President's purpose and job description.
        await pg.waitForFunction(() => document.getElementById('my-job-card')?.style.display !== 'none', { timeout: 15000 }).catch(() => {});
        const job = await pg.evaluate(() => ({
          title: document.querySelector('#my-job-card h2')?.textContent,
          desc: document.querySelector('#my-job-card details')?.textContent || '',
          shown: document.getElementById('my-job-card')?.style.display !== 'none',
        }));
        check('K4: the dashboard shows "Your job: President" with the job description',
          job.shown && /Your job: President/.test(job.title || '') && /Every month/.test(job.desc), JSON.stringify(job).slice(0, 200));
        check('J1: the dashboard shows the one checklist (9 items, real screens)',
          setup.shown && (setup.folded || (setup.rows === 9 && setup.links.every(h => !/wizard|setup\.html/.test(h)))), JSON.stringify(setup).slice(0, 220));
      }
      if (path === '/club/admin/payments.html') {
        // J8: prices are on this page, inside Money setup with the rest.
        const money = await pg.evaluate(() => {
          const setup = document.getElementById('setup-section');
          return {
            tiers: [...document.querySelectorAll('#tiers-list .tier-row [data-field="label"]')].map(i => i.value),
            inSetup: ['prices-card', 'plans-card', 'late-fee-card', 'test-mode-card'].every(id => setup && setup.contains(document.getElementById(id))),
            tiersLink: !!document.querySelector('a[href*="tiers.html"]'),
          };
        });
        check('J8: Money setup holds prices, plans, late fees and test payments',
          money.tiers.length >= 1 && money.tiers.includes('Family') && money.inSetup && !money.tiersLink, JSON.stringify(money));
        const codes = await pg.evaluate(() => ({
          inSetup: document.getElementById('setup-section').contains(document.getElementById('discounts-card')),
          list: document.getElementById('codes-list')?.textContent.trim().slice(0, 60),
        }));
        check('H7: Money setup has Discounts, and the code list loads', codes.inSetup && codes.list && !/Loading|error/i.test(codes.list), JSON.stringify(codes));
        const refs = await pg.evaluate(() => ({
          list: document.getElementById('ref-list')?.textContent.trim().slice(0, 80),
          totals: document.getElementById('ref-totals')?.textContent.replace(/\s+/g, ' ').trim(),
          reward: document.getElementById('ref-reward')?.value, newFam: document.getElementById('ref-newfam')?.value,
        }));
        check('H6: Money shows Referral rewards with totals, and the referral amounts', refs.list && !/Loading|Could not/.test(refs.list)
          && /Credit owed/.test(refs.totals) && Number(refs.reward) > 0 && refs.newFam !== '', JSON.stringify(refs));
      }
      if (path === '/club/admin/settings.html') {
        // J5–J7: Season has the on-sale month, hours per day, one gate section.
        const set = await pg.evaluate(() => ({
          onSale: document.getElementById('renewal_opens_month')?.value,
          note: document.getElementById('selling-note')?.textContent || '',
          days: document.querySelectorAll('[data-day-hours]').length,
          gate: document.getElementById('gate-card')?.innerText.slice(0, 40) || '',
          methods: document.querySelectorAll('#access-methods input[type="checkbox"]').length,
          remote: getComputedStyle(document.getElementById('gate-remote')).display,
        }));
        check('J5–J7: Settings shows the on-sale month, 7 day rows and one Gate & check-in section',
          set.onSale && /season/.test(set.note) && set.days === 7 && /Gate & check-in/.test(set.gate) && set.methods >= 1 && set.remote !== 'none', JSON.stringify(set));
      }
      if (path === '/club/admin/board.html') {
        // K2: the Board page: the spending rule, every position with its
        // holder, alerts and job description, and the president's buttons.
        const bp = await pg.evaluate(() => ({
          rule: document.querySelector('#spending-rule .text')?.textContent,
          cards: document.querySelectorAll('[data-position]').length,
          pres: document.querySelector('[data-position] .pos-who')?.textContent.trim(),
          jobs: document.querySelectorAll('details.job').length,
          chips: document.querySelectorAll('.chip').length,
          edit: document.querySelectorAll('[data-position] .actions button').length,
          wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        }));
        check('K2: the Board page shows the rule, 8 positions with holders, alerts and job descriptions',
          /Under \$50/.test(bp.rule || '') && bp.cards === 8 && /Doug/.test(bp.pres || '') && bp.jobs === 8 && bp.chips >= 8 && bp.edit >= 16 && bp.wide <= 1, JSON.stringify(bp));
        await pg.evaluate(() => document.querySelector('[data-position]:nth-child(3) details.job')?.setAttribute('open', ''));
        await pg.screenshot({ path: '/tmp/poolside-board.png', fullPage: false });
        await pg.evaluate(() => editPosition(document.querySelector('[data-position]:nth-child(3)').dataset.position));
        await pg.screenshot({ path: '/tmp/poolside-board-edit.png' });
      }
      if (path === '/club/admin/board-meetings.html') {
        await pg.waitForFunction(() => /Bylaws/.test(document.getElementById('bylaws-card')?.textContent || ''), { timeout: 15000 }).catch(() => {});
        const by = await pg.evaluate(() => document.getElementById('bylaws-card')?.innerText.replace(/\s+/g, ' ') || '');
        check('K6: the Board minutes page has the bylaws card, with upload for the president', /Bylaws/.test(by) && /Upload/.test(by) && /public/.test(by), by.slice(0, 160));
        // L1–L3: the Next meeting card, and the agenda view (sample data, so
        // nothing real is created).
        await pg.waitForFunction(() => /Not planned yet|·/.test(document.getElementById('next-when')?.textContent || ''), { timeout: 15000 }).catch(() => {});
        const nx = await pg.evaluate(() => ({
          max: document.getElementById('item-input')?.maxLength,
          count: document.getElementById('item-count')?.textContent,
          create: /Create agenda/.test(document.getElementById('agenda-actions')?.textContent || ''),
        }));
        check('L1: the Next meeting card has the one-line box (100), its counter, and Create agenda', nx.max === 100 && nx.count === '0/100' && nx.create, JSON.stringify(nx));
        await pg.evaluate(() => showAgenda({
          meeting: { id: 'sample', agenda_created_at: '2026-10-06T12:00:00Z', agenda_sent_at: null },
          created_by_name: 'Doug Frevele', text: '',
          agenda: { title: 'Board Meeting', date: '2026-10-10', time: '10:00', location: 'Clubhouse', sections: [
            { key: 'open', title: 'Call to order and roll call' },
            { key: 'minutes', title: 'Approve the minutes of the September 12 meeting' },
            { key: 'reports', title: 'Reports and items', people: [
              { name: 'Doug Frevele', titles: ['President'], items: [{ id: '1', body: 'Close for the season Oct 18' }] },
              { name: 'Kristin', titles: ['Membership & Marketing Director'], items: [{ id: '2', body: 'Bathrooms have been complained about' }, { id: '3', body: 'New lounge chairs', carried_from_date: '2026-09-12' }] },
              { name: 'Sam', titles: ['Treasurer'], items: [] } ] },
            { key: 'old', title: 'Open action items from past meetings', followUps: [{ description: 'Get 3 quotes on the pump', assigned_to: 'Facilities', due_date: '2026-10-01' }] },
            { key: 'actions', title: 'Action list: who, what, by when' },
            { key: 'close', title: 'Set the next meeting, adjourn' } ] },
        }));
        const ag = await pg.evaluate(() => ({
          text: document.getElementById('agenda-body')?.innerText.replace(/\s+/g, ' '),
          send: /Send to the board/.test(document.getElementById('agenda-foot')?.textContent || ''),
        }));
        check('L2/L3: the agenda view reads in the agreed format, with Send to the board',
          /3\. Reports and items/.test(ag.text) && /Kristin, Membership & Marketing Director – Bathrooms have been complained about/.test(ag.text) && ag.send, (ag.text || '').slice(0, 200));
        await pg.screenshot({ path: '/tmp/poolside-agenda.png' });
        await pg.evaluate(() => closeAgenda());
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
    // K6: the public "Bylaws & board minutes" page: bylaws first, then the board.
    const gov = await open('/governance.html');
    await gov.waitForFunction(() => !document.querySelector('#bylaws-host .meeting-card[style*="height"]'), { timeout: 15000 }).catch(() => {});
    const g = await gov.evaluate(() => ({
      bylaws: document.getElementById('bylaws-host')?.innerText.trim(),
      board: document.getElementById('board-host')?.innerText.trim(),
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    check('K6: the public page shows the bylaws section and the board (names and positions)',
      /bylaws/i.test(g.bylaws || '') && /Doug.*President/.test(g.board || '') && g.wide <= 1 && gov.errs.length === 0, JSON.stringify(g).slice(0, 200));
    await gov.screenshot({ path: '/tmp/poolside-governance.png' });
    }

    const m = await makeTempMember(sql, club.id, FAMILY);
    if (want('renew')) {
    // H5: the signed-in renewal page takes their referral credit off. Outside
    // the renewal window the page says renewals aren't open, so the answer's
    // open/paid flags are set for the render; the price is the server's.
    await sql(`update households set referral_credits_cents = 10000, paid_until_year = extract(year from now())::int - 1 where id = '${m.household_id}'`);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: m.household_id });
    const rp = await open('/m/renew.html', { poolside_member_token: memTok },
      (action, json) => action === 'renewal_options' && json ? { ...json, open: true, already_paid: false } : json);
    await rp.waitForSelector('.amount', { timeout: 20000 });
    const shown = await rp.evaluate(() => document.getElementById('root').innerText.replace(/\s+/g, ' '));
    check('H5: the renewal page shows their $100 referral credit off', /Your referral credit/.test(shown) && /−\$100\.00/.test(shown) && /Have a code\?/.test(shown), shown.slice(0, 200));
    await rp.evaluate(() => { document.getElementById('code-toggle').click(); document.getElementById('code-in').value = 'NOSUCHCODE'; document.getElementById('code-apply').click(); });
    await rp.waitForFunction(() => /isn't valid/.test(document.getElementById('root').innerText), { timeout: 15000 }).catch(() => {});
    const after = await rp.evaluate(() => document.getElementById('root').innerText.replace(/\s+/g, ' '));
    check('H5: a wrong code on the renewal page says why, and the credit stays', /isn't valid/.test(after) && /Your referral credit/.test(after), after.slice(0, 200));
    check('H5: renewal page has no page errors', rp.errs.length === 0, rp.errs.join(' | '));
    await rp.screenshot({ path: '/tmp/poolside-renew-credit.png' });
    }
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
    // H7: a code marked for the member home shows as a banner while they
    // still owe. A sample code is added to the page's data for the render.
    await sql(`update households set paid_until_year = extract(year from now())::int - 1 where id = '${m.household_id}'`);
    const h = await open('/m/', { poolside_member_token: memTok }, (action, json) =>
      json && json.public_settings ? { ...json, public_settings: { ...json.public_settings,
        home_codes: [{ code: 'EARLYBIRD', label: 'Early bird', amount_cents: 5000, percent_off: null, expires_on: '2099-03-01' }] } } : json);
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
    const banner = await h.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').match(/Early bird: [^.]*?EARLYBIRD[^.]*?2099|Early bird: \$50 off with code EARLYBIRD through [A-Z][a-z]{2} 1/)?.[0] || '');
    check('H7: the member home shows the early-bird code', /\$50 off with code EARLYBIRD through Mar 1/.test(banner), banner || 'no banner');
    // H6: the Refer panel spells out the rules before anything else.
    await h.evaluate(() => openReferModal());
    await h.waitForFunction(() => /30 days/.test(document.getElementById('refer-rules')?.textContent || ''), { timeout: 15000 }).catch(() => {});
    const rules = await h.evaluate(() => ({ title: document.getElementById('refer-title')?.textContent, rules: document.getElementById('refer-rules')?.innerText.replace(/\s+/g, ' ') }));
    check('H6: the Refer panel shows the rules: save, 30 days, choice, board, free membership',
      /earn \$\d/.test(rules.title || '') && /saves \$\d/.test(rules.rules) && /30 days/.test(rules.rules) && /credit toward your next dues, or a refund/.test(rules.rules)
        && /board approves/.test(rules.rules) && /free membership/.test(rules.rules), JSON.stringify(rules).slice(0, 300));
    await h.screenshot({ path: '/tmp/poolside-refer-rules.png' });
    await h.evaluate(() => closeReferModal());
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

    if (want('plans')) {
    // PLAN.md M: the plan picker, the family's plan card and the board's
    // table. Bishop sells the 2026 season until December, so a 2027 plan is
    // put in the server's answers for the render, priced by the real code.
    const { importTs } = await import('./importts.mjs');
    const pq = await importTs(new URL('../../supabase/functions/_shared/plan_quote.ts', import.meta.url));
    const ops = await importTs(new URL('../../supabase/functions/_shared/plan_ops.ts', import.meta.url));
    const [{ today }] = await sql(`select to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD') as today`);
    const fake = {
      tenantId: club.id, slug: 'bishopestates', name: 'Bishop Estates', tz: 'America/Los_Angeles', today, sv: {}, opensMonth: 12,
      cfg: ops.planConfig({ payments: { plan: { enabled: true, access_when: 'half_paid',
        milestones: [{ date: '04-10', min_pct: 50, label: 'Half paid' }, { date: '07-15', min_pct: 100, label: 'Paid in full' }] } } }),
      passFee: true, pct: 0.029, fixed: 30, stripeAccount: null, chargesEnabled: false, feesWaived: true, testMode: true, clubUrl: HOST,
    };
    const quote = body => pq.quotePlan(fake, { totalCents: 60000, tierSlug: 'family', year: 2027, policy: { waived: true },
      todayCents: body?.plan_today_cents ?? null, payoffMonth: body?.plan_payoff_month ?? null });

    const ap = await open('/apply.html', {}, (action, json, body) => {
      if (json && json.public_settings) return { ...json, public_settings: { ...json.public_settings, payment_plan: { ...(json.public_settings.payment_plan || {}), enabled: true } } };
      if (action === 'quote' && json) return { ...json, plan: quote(body) };
      return json;
    });
    await ap.evaluate(async () => { showStep(4); await refreshQuote(); });
    await wait(500);
    const opt = await ap.evaluate(() => getComputedStyle(document.getElementById('pay-opt-stripe-plan')).display);
    check('M3: the join form offers "Payment plan"', opt !== 'none', opt);
    await ap.evaluate(() => { const r = document.querySelector('input[name="payment_method"][value="stripe_plan"]'); r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); });
    await ap.waitForSelector('#pp-result table', { timeout: 15000 }).catch(() => {});
    const pick1 = await ap.evaluate(() => ({ text: document.getElementById('plan-picker').innerText.replace(/\s+/g, ' '), months: document.querySelectorAll('#pp-month option').length }));
    check('M3: "Pay today" and "Paid off by", then every date and amount', /Pay today/i.test(pick1.text) && /Paid off by/i.test(pick1.text) && /Total \$\d/i.test(pick1.text) && pick1.months >= 6, pick1.text.slice(0, 240));
    await ap.evaluate(() => { const t = document.getElementById('pp-today'); t.value = '5'; t.dispatchEvent(new Event('input')); });
    await ap.waitForFunction(() => /at least \$25/.test(document.getElementById('pp-result').innerText), { timeout: 15000 }).catch(() => {});
    const small = await ap.$eval('#pp-result', el => el.innerText.replace(/\s+/g, ' '));
    check('M3: $5 today is refused with the reason', /\$0 today, or at least \$25/.test(small), small.slice(0, 160));
    await ap.evaluate(() => { const t = document.getElementById('pp-today'); t.value = '100'; t.dispatchEvent(new Event('input')); });
    await ap.waitForFunction(() => /Today/.test(document.getElementById('pp-result').innerText), { timeout: 15000 }).catch(() => {});
    const ok100 = await ap.evaluate(() => ({ text: document.getElementById('pp-result').innerText.replace(/\s+/g, ' '), choice: PlanPicker.choice(),
      wide: document.documentElement.scrollWidth - document.documentElement.clientWidth }));
    check('M3: $100 today shows today first, then monthly; checkout gets that choice', /Today \$\d/.test(ok100.text) && ok100.choice?.today_cents === 10000 && !!ok100.choice?.payoff_month, JSON.stringify(ok100).slice(0, 240));
    check('M3: fits a phone', ok100.wide <= 1, String(ok100.wide));
    check('M3: join form has no page errors', ap.errs.length === 0, ap.errs.join(' | '));
    await ap.evaluate(() => document.getElementById('plan-picker').scrollIntoView());
    await ap.screenshot({ path: '/tmp/poolside-plan-picker.png' });

    // The family's own plan on the member home: past due, then lapsed.
    const rows = [1, 2, 3, 4, 5, 6].map(i => ({ id: 'i' + i, sequence: i, due_date: `2027-0${i}-07`, amount_cents: 10000, plan_fee_cents: 0, card_fee_cents: 330, status: i === 1 ? 'paid' : i === 2 ? 'retrying' : 'pending', last_error: i === 2 ? 'Your card was declined.' : null }));
    const view = (status) => ({ ...ops.planView({ ...fake, today: '2027-02-10' }, { id: 'p1', status, total_cents: 60000, family_name: FAMILY, stripe_payment_method_id: 'pm_x', ended_reason: status === 'active' ? null : 'card_failed' }, rows), year: 2027 });
    const memTok2 = jwt({ sub: m.id, kind: 'member', tid: club.id, slug: 'bishopestates', hid: m.household_id });
    let planStatus = 'active';
    const hp = await open('/m/#plan', { poolside_member_token: memTok2 }, (action, json) => action === 'me' && json ? { ...json, plan: view(planStatus) } : json);
    await hp.waitForSelector('#plan', { timeout: 30000 }).catch(() => {});
    const card = await hp.evaluate(() => document.getElementById('plan')?.innerText.replace(/\s+/g, ' ') || '');
    check('M5: the family sees paid, balance, next payment', /\$100\.00 paid of \$600\.00/.test(card) && /\$500\.00 left/.test(card) && /Next payment/.test(card), card.slice(0, 200));
    check('M5: past due says so, with Update card and pay now, Pay off, Cancel', /didn't go through/.test(card) && /Update card and pay now/i.test(card) && /Pay off \$515\.\d\d/i.test(card) && /Cancel plan/i.test(card), card.slice(0, 300));
    check('M5: gate and fob wait for half', /start once half is paid/.test(card), card.slice(0, 300));
    await hp.evaluate(() => document.getElementById('plan')?.scrollIntoView());
    await hp.screenshot({ path: '/tmp/poolside-my-plan.png' });
    planStatus = 'lapsed';
    await hp.reload({ waitUntil: 'networkidle2' });
    await hp.waitForSelector('#plan', { timeout: 30000 }).catch(() => {});
    const gone = await hp.evaluate(() => document.getElementById('plan')?.innerText.replace(/\s+/g, ' ') || '');
    check('M5: lapsed: membership canceled, Reinstate with the amount', /membership is canceled/.test(gone) && /Reinstate: pay \$\d/i.test(gone) && /\$50\.00 reactivation fee/.test(gone), gone.slice(0, 300));
    check('M5: member home has no page errors', hp.errs.length === 0, hp.errs.join(' | '));

    // The board's table and settings.
    const ownerTok2 = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    const listed = ['active', 'lapsed'].map(st => ({ ...view(st), id: 'p-' + st, primary_email: 'x@example.com' }));
    const pay = await open('/club/admin/payments.html', { poolside_tenant_token: ownerTok2 }, (action, json) =>
      action === 'list_plans' && json ? { ...json, plans: listed, test_mode: true } : json);
    await pay.waitForSelector('#plans-list table', { timeout: 30000 }).catch(() => {});
    await pay.waitForSelector('#plan-tiers input', { timeout: 15000 }).catch(() => {});
    const tbl = await pay.evaluate(() => ({
      head: [...document.querySelectorAll('#plans-list th')].map(t => t.textContent).join('|'),
      body: document.querySelector('#plans-list tbody')?.textContent.replace(/\s+/g, ' ') || '',
      access: document.getElementById('plan-access')?.value, tiers: document.querySelectorAll('#plan-tiers input').length,
    }));
    check('M6: the board table: member, plan, paid, balance, next charge, status, fob', tbl.head === 'Member|Plan|Paid|Balance|Next charge|Status|Fob', tbl.head);
    check('M6: past due and lapsed rows say so', /Past due/i.test(tbl.body) && /Lapsed/i.test(tbl.body), tbl.body.slice(0, 200));
    check('M2: Bishop\'s settings: gate at half paid, a box per membership type', tbl.access === 'half_paid' && tbl.tiers >= 2, JSON.stringify(tbl).slice(0, 160));
    check('M6: payments page has no page errors', pay.errs.length === 0, pay.errs.join(' | '));
    await pay.evaluate(() => { const d = document.getElementById('plans')?.closest('details'); if (d) d.open = true; document.getElementById('plans')?.scrollIntoView(); });
    await pay.screenshot({ path: '/tmp/poolside-plans-table.png' });
    }
  } finally {
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    await browser.close();
  }
}

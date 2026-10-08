#!/usr/bin/env node
// Phone-width sweep (PLAN.md N8): every board, member and public page at
// iPhone size (390px), with every pop-up window opened in turn. Anything
// wider than the screen is listed. Serves this checkout's copies of the
// pages; the data comes from the live functions (Bishop, as Doug), so it
// costs about two calls a page.
//
// Usage: node scripts/check_phone_width.mjs [page-substring]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import puppeteer from 'puppeteer-core';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root));
const env = Object.fromEntries(read('.env.local').toString().split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const HOST = 'https://bishopestates.poolsideapp.com';
const ONLY = process.argv[2] || '';
const b64 = b => Buffer.from(b).toString('base64url');
const jwt = p => {
  const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${h}.${body}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
};
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-width/1.0' },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
const [member] = await sql(`select m.id, m.household_id from household_members m join households h on h.id = m.household_id
  where m.tenant_id = '${club.id}' and m.active and h.active order by m.role = 'primary' desc limit 1`);
const adminTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
const memberTok = member ? jwt({ sub: member.id, kind: 'member', tid: club.id, hid: member.household_id, slug: 'bishopestates' }) : null;

const TYPES = { html: 'text/html', js: 'application/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', json: 'application/json' };
const localFor = path => {
  let rel = decodeURIComponent(path).replace(/^\//, '');
  if (rel === '' ) rel = 'club/index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  return existsSync(new URL(rel, root)) ? rel : null;
};

const pages = [];
for (const f of readdirSync(new URL('club/admin/', root))) if (f.endsWith('.html')) pages.push({ path: `/club/admin/${f}`, store: { poolside_tenant_token: adminTok } });
for (const f of readdirSync(new URL('m/', root))) if (f.endsWith('.html') && memberTok) pages.push({ path: `/m/${f}`, store: { poolside_member_token: memberTok } });
for (const f of ['club/index.html', 'apply.html', 'renew.html', 'governance.html', 'pay-test.html']) pages.push({ path: '/' + f, store: {} });

const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox'] });
const problems = [];
let checked = 0;
try {
  for (const pg of pages.filter(p => !ONLY || p.path.includes(ONLY))) {
    const ctx = await browser.createBrowserContext();
    const p = await ctx.newPage();
    await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    await p.evaluateOnNewDocument(s => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, pg.store);
    await p.setRequestInterception(true);
    p.on('request', r => {
      const u = new URL(r.url());
      const rel = u.origin === HOST ? localFor(u.pathname) : null;
      if (rel) return r.respond({ status: 200, contentType: TYPES[rel.split('.').pop()] || 'text/plain', body: read(rel) });
      r.continue();
    });
    p.on('dialog', d => d.dismiss());
    try {
      await p.goto(HOST + pg.path, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (e) { problems.push(`${pg.path}: did not load (${e.message.slice(0, 60)})`); await ctx.close(); continue; }
    await new Promise(r => setTimeout(r, 800));
    const found = await p.evaluate(() => {
      const out = [];
      const vw = document.documentElement.clientWidth;
      const wide = () => Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - vw;
      // What sticks out past the right edge, by its id or class.
      const culprit = () => {
        let worst = null;
        for (const el of document.querySelectorAll('body *')) {
          const r = el.getBoundingClientRect();
          if (r.width && r.right > vw + 1 && getComputedStyle(el).position !== 'fixed' && !el.closest('[style*="overflow-x:auto"], [style*="overflow-x: auto"], .table-wrap')) {
            if (!worst || r.right > worst.r) worst = { r: Math.round(r.right), what: el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '') };
          }
        }
        return worst;
      };
      if (wide() > 1) out.push({ where: 'page', by: wide(), culprit: culprit() });
      const pops = [...document.querySelectorAll('.scrim, .pscrim, [id$="-scrim"], .modal-scrim')];
      for (const s of pops) {
        const had = s.className;
        s.classList.add('open', 'show');
        const box = s.querySelector('.modal, .pmodal, .sheet, [class*="modal"]') || s;
        const r = box.getBoundingClientRect();
        const inner = box.scrollWidth - box.clientWidth;
        if (r.width && (r.right > vw + 1 || r.left < -1 || inner > 1)) {
          out.push({ where: '#' + (s.id || s.className), by: Math.round(Math.max(r.right - vw, -r.left, inner)), culprit: culprit() });
        }
        s.className = had;
      }
      return out;
    });
    checked++;
    for (const f of found) problems.push(`${pg.path} ${f.where}: ${f.by}px too wide${f.culprit ? ` (widest: ${f.culprit.what})` : ''}`);
    await ctx.close();
  }
} finally { await browser.close(); }
console.log(`${checked} pages checked at 390px`);
console.log(problems.length ? problems.map(x => '  ✗ ' + x).join('\n') : '  ✓ nothing wider than the screen');
process.exit(problems.length ? 1 : 0);

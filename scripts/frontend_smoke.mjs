// =============================================================================
// frontend_smoke.mjs — headless render check for EVERY page (public + authed)
// =============================================================================
// Loads each page in a real headless Chrome with a valid (HMAC-signed) admin /
// member / provider token injected into localStorage, and flags:
//   • uncaught JS exceptions (pageerror)
//   • console.error from the page's own code
//   • failed/4xx-5xx requests to our own origins (site + supabase functions)
//   • an authed page bouncing to a login screen (token rejected / render bail)
//   • fatal on-page error text ("Network error", "not found", etc.)
// Run:  node scripts/frontend_smoke.mjs
// =============================================================================
import fs from 'node:fs';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer-core';

const ENV = {};
for (const line of fs.readFileSync('.env.local', 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  ENV[t.slice(0, i).trim()] = t.slice(i + 1).trim();
}
const SECRET = ENV.ADMIN_JWT_SECRET;
const ACCESS = ENV.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = ENV.SUPABASE_PROJECT_REF || 'sdewylbddkcvidwosgxo';
const SUPA = ENV.SUPABASE_URL.replace(/\/$/, '');
const SLUG = 'bishopestates';
const HOST = `https://${SLUG}.poolsideapp.com`;
const ROOT = 'https://poolsideapp.com';
// puppeteer-core ships no browser of its own, so we point it at an installed
// Chrome. The path differs per machine, hence: CHROME_PATH first (set it when
// yours lives somewhere unusual), then the standard location for each OS.
const CHROME = (() => {
  if (ENV.CHROME_PATH || process.env.CHROME_PATH) return ENV.CHROME_PATH || process.env.CHROME_PATH;
  const candidates = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ],
    linux: ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium'],
  }[process.platform] || [];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) {
    console.error(`No Chrome found for ${process.platform}. Looked in:\n  ${candidates.join('\n  ')}\nSet CHROME_PATH to override.`);
    process.exit(1);
  }
  return found;
})();

const b64url = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signJwt(payload) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64url(sig)}`;
}
const exp = () => Math.floor(Date.now() / 1000) + 3600;

async function mgmt(sql) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS}`, 'Content-Type': 'application/json', 'User-Agent': 'poolside-smoke/1.0' },
    body: JSON.stringify({ query: sql }),
  });
  return r.json();
}
async function fn(name, body, token) {
  const r = await fetch(`${SUPA}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return r.json();
}

// ── Resolve ids + mint tokens ────────────────────────────────────────────
const TID = (await mgmt(`select id from tenants where slug='${SLUG}'`))[0].id;
const ADMIN_ID = (await mgmt(`select id from admin_users where tenant_id='${TID}' and active=true and role_template='owner' limit 1`))[0].id;
const PROVIDER_ID = (await mgmt(`select id from provider_admins where active=true limit 1`))[0].id;

const adminTok = signJwt({ sub: ADMIN_ID, kind: 'tenant_admin', tid: TID, slug: SLUG, exp: exp() });
const providerTok = signJwt({ sub: PROVIDER_ID, kind: 'provider', exp: exp() });

// Create a throwaway household so member pages have a real member to render as.
const STAMP = String(Date.now()).slice(-6);
const hh = await fn('households_admin', {
  action: 'create_household', family_name: `Smoke ${STAMP}`,
  primary: { name: `Smoke Member ${STAMP}`, phone_e164: `+1555${STAMP}00` },
}, adminTok);
let MEMBER_ID = null, HID = null;
if (hh.ok) {
  HID = hh.household_id;
  const m = await mgmt(`select id from household_members where household_id='${HID}' and role='primary' limit 1`);
  MEMBER_ID = m[0]?.id;
}
const memberTok = MEMBER_ID ? signJwt({ sub: MEMBER_ID, kind: 'member', tid: TID, slug: SLUG, hid: HID, exp: exp() }) : null;

const LS = {
  none: {},
  admin: {
    poolside_tenant_token: adminTok,
    poolside_tenant_user: JSON.stringify({ id: ADMIN_ID, role_template: 'owner', scopes: [], is_default_pw: false, is_super: false }),
    poolside_tenant_tenant: JSON.stringify({ slug: SLUG, display_name: 'Bishop Estates', status: 'active' }),
  },
  member: memberTok ? { poolside_member_token: memberTok } : {},
  provider: {
    poolside_provider_token: providerTok,
    poolside_provider_user: JSON.stringify({ id: PROVIDER_ID, email: 'doug@poolsideapp.com', is_super: true }),
  },
};

// ── Page manifest ────────────────────────────────────────────────────────
const ADMIN_PAGES = ['', 'members.html', 'applications.html', 'application.html', 'payments.html', 'billing.html',
  'events.html', 'parties.html', 'programs.html', 'lifeguards.html', 'my-shifts.html', 'volunteer.html',
  'guest-passes.html', 'campaigns.html', 'policies.html', 'sponsors.html', 'donations.html', 'board-meetings.html',
  'audit.html', 'emails.html', 'feedback.html', 'photos.html', 'checkin.html', 'settings.html', 'admins.html',
  'change-password.html', 'health.html', 'help.html', 'impact.html', 'setup.html',
  'import.html', 'migrate.html'];

const PAGES = [
  ...['/', '/home.html', '/pricing.html', '/signup.html', '/privacy.html', '/terms.html', '/governance.html', '/setup-service.html', '/wizard.html'].map(p => ({ url: ROOT + p, auth: 'none' })),
  ...['/club/', '/apply.html', '/m/login.html', '/club/admin/login.html', '/club/wizard.html'].map(p => ({ url: HOST + p, auth: 'none' })),
  ...['/admin/login.html'].map(p => ({ url: ROOT + p, auth: 'none' })),
  ...ADMIN_PAGES.map(p => ({ url: `${HOST}/club/admin/${p}`, auth: 'admin' })),
  ...['/m/', '/m/family.html'].map(p => ({ url: HOST + p, auth: 'member' })),
  ...['/admin/', '/admin/analytics.html', '/admin/gate-integrations.html', '/admin/profile.html', '/admin/change-password.html'].map(p => ({ url: ROOT + p, auth: 'provider' })),
];

const isOurs = (u) => /poolsideapp\.com|supabase\.co\/functions/.test(u) && !/\.(png|jpg|jpeg|webp|svg|ico|woff2?|css)(\?|$)/i.test(u);
const FATAL_TEXT = ['Network error', 'Something went wrong', 'Cannot read', 'is not defined', 'is not a function', 'undefined is not'];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'] });

const results = [];
for (const pg of PAGES) {
  const page = await browser.newPage();
  const errs = [];
  await page.evaluateOnNewDocument((data) => {
    try { for (const [k, v] of Object.entries(data)) localStorage.setItem(k, v); } catch (e) {}
  }, LS[pg.auth] || {});
  page.on('pageerror', (e) => errs.push('JS-EXCEPTION: ' + e.message.split('\n')[0]));
  page.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (!/Failed to load resource/.test(t)) errs.push('console.error: ' + t.slice(0, 160)); } });
  page.on('requestfailed', (r) => { if (isOurs(r.url())) errs.push('REQ-FAILED: ' + r.url().replace(SUPA, '') + ' (' + (r.failure()?.errorText || '') + ')'); });
  page.on('response', (r) => { if (r.status() >= 400 && isOurs(r.url())) errs.push('HTTP-' + r.status() + ': ' + r.url().replace(SUPA, '').replace(HOST, '').replace(ROOT, '')); });

  let finalUrl = pg.url, bodyText = '';
  try {
    await page.goto(pg.url, { waitUntil: 'networkidle2', timeout: 25000 });
    await new Promise(r => setTimeout(r, 1200)); // let late async API calls settle
    finalUrl = page.url();
    bodyText = await page.evaluate(() => document.body ? document.body.innerText : '');
  } catch (e) {
    errs.push('NAV-FAIL: ' + e.message.split('\n')[0]);
  }

  // Authed page bounced to a login screen → token rejected / render bailed.
  const bounced = pg.auth !== 'none' && /login\.html/.test(finalUrl) && !/login\.html/.test(pg.url);
  if (bounced) errs.push('AUTH-BOUNCE: redirected to ' + finalUrl.replace(HOST, '').replace(ROOT, ''));
  for (const f of FATAL_TEXT) if (bodyText.includes(f)) errs.push('PAGE-TEXT: "' + f + '"');
  if (bodyText.trim().length < 15 && !errs.length) errs.push('EMPTY: body had <15 chars of text');

  const label = pg.url.replace(ROOT, '').replace(HOST, '') + '  [' + pg.auth + ']';
  results.push({ label, errs });
  console.log((errs.length ? 'FAIL ' : 'ok   ') + label + (errs.length ? '\n        ' + errs.join('\n        ') : ''));
  await page.close();
}

await browser.close();

// Cleanup the throwaway household.
if (HID) await mgmt(`delete from households where id='${HID}'`);

const failed = results.filter(r => r.errs.length);
console.log(`\n${results.length - failed.length}/${results.length} pages clean` + (failed.length ? `  —  ${failed.length} with findings` : ''));
process.exit(failed.length ? 1 : 0);

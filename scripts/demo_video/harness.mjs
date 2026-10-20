// =============================================================================
// harness.mjs — the demo video's browser (PLAN.md BD)
// =============================================================================
// Serves this folder's pages as if they were live at maplegrove.poolsideapp.com
// and answers every Supabase call from data.mjs, so the video shows a made-up
// club and uses no calls. Nothing addressed to Supabase is ever let through:
// an unknown call gets a bare { ok: true } and is listed in `unknown`.
//
// Two phones share the club's address but not their storage: the family's
// phone is on the normal port and the board's on 8443 (a different origin to
// the browser, the same hostname to the app's club lookup).
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { respond, weather, DEMO_NOW } from './data.mjs';

export const WEB = new URL('../../', import.meta.url).pathname;
const require = createRequire(WEB + 'package.json');
const puppeteer = require('puppeteer-core');

export const CLUB_HOST = 'maplegrove.poolsideapp.com';
export const FAMILY = `https://${CLUB_HOST}`;
export const BOARD = `https://${CLUB_HOST}:8443`;
export const STAGE = `https://${CLUB_HOST}:9443`;

const TYPES = {
  html: 'text/html', js: 'application/javascript', mjs: 'application/javascript', css: 'text/css',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', json: 'application/json',
  webmanifest: 'application/manifest+json', md: 'text/markdown', ico: 'image/x-icon', woff2: 'font/woff2',
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };

export async function launch(opts = {}) {
  return puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb', '--font-render-hinting=none'],
    ...opts,
  });
}

// Runs in every page and frame before the app's own scripts.
function inPage(nowMs) {
  // The demo happens on a June Saturday, mid-morning.
  const shift = nowMs - Date.now();
  const RealDate = Date;
  class DemoDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); }
    static now() { return RealDate.now() + shift; }
  }
  // eslint-disable-next-line no-global-assign
  Date = DemoDate;
  // No service worker: its fetches would skip the demo's answers.
  const sw = { register: () => Promise.resolve({}), getRegistration: () => Promise.resolve(undefined), getRegistrations: () => Promise.resolve([]),
    ready: new Promise(() => {}), controller: null, addEventListener() {}, removeEventListener() {} };
  try { Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true }); } catch (_) {}
  const tok = 'demo.eyJleHAiOjQxMDI0NDQ4MDAsInN1YiI6ImRlbW8ifQ.demo';
  try {
    if (location.port === '8443') {
      localStorage.setItem('poolside_tenant_token', tok);
      localStorage.setItem('poolside_tenant_user', JSON.stringify({ id: 'demo-board', display_name: 'Sam Brooks' }));
      localStorage.setItem('poolside_tenant_tenant', JSON.stringify({ slug: 'maplegrove', display_name: 'Maple Grove Swim Club' }));
    } else if (location.port === '') {
      localStorage.setItem('poolside_member_token', tok);
      localStorage.setItem('poolside_member_tenant', 'maplegrove');
      localStorage.removeItem('poolside_tenant_token');
    }
  } catch (_) {}
}

/** Wire a page: files, answers, the demo clock. Returns the call log. */
export async function attach(page, { state = {}, extraFiles = {} } = {}) {
  const log = { calls: [], unknown: [], errors: [], external: new Set() };
  page.on('pageerror', e => log.errors.push(String(e.message).slice(0, 160)));
  await page.emulateTimezone('America/Los_Angeles');
  await page.evaluateOnNewDocument(inPage, DEMO_NOW);
  await page.setRequestInterception(true);
  page.on('request', r => {
    const u = new URL(r.url());
    // data: and blob: images are the page's own, not the network.
    if (!/^https?:$/.test(u.protocol)) return r.continue();
    if (u.hostname.endsWith('.supabase.co')) {
      if (r.method() === 'OPTIONS') return r.respond({ status: 200, headers: CORS, body: 'ok' });
      let body = {};
      try { body = JSON.parse(r.postData() || '{}'); } catch (_) {}
      const fn = u.pathname.split('/').pop();
      const side = (r.frame() && new URL(r.frame().url()).port === '8443') ? 'board' : 'family';
      const out = respond(fn, body, { side, state });
      log.calls.push(`${side} ${fn}:${body.action ?? '-'}`);
      if (out === undefined) log.unknown.push(`${side} ${fn}:${body.action ?? '-'}`);
      return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(out ?? { ok: true }) });
    }
    if (u.hostname === 'api.open-meteo.com') {
      return r.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(weather()) });
    }
    if (u.hostname === CLUB_HOST) {
      if (extraFiles[u.pathname]) {
        return r.respond({ status: 200, contentType: 'text/html', body: readFileSync(extraFiles[u.pathname]) });
      }
      let rel = decodeURIComponent(u.pathname).replace(/^\//, '');
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      if (rel === 'manifest.webmanifest') return r.respond({ status: 200, contentType: TYPES.webmanifest, body: '{"name":"Maple Grove","display":"standalone"}' });
      if (existsSync(WEB + rel)) {
        return r.respond({ status: 200, contentType: TYPES[rel.split('.').pop()] || 'text/plain', body: readFileSync(WEB + rel) });
      }
      return r.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
    }
    // Fonts and the QR library come from their CDNs; nothing else leaves.
    if (/^(fonts\.(googleapis|gstatic)\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com)$/.test(u.hostname)) {
      return r.continue();
    }
    log.external.add(u.hostname);
    return r.respond({ status: 204, body: '' });
  });
  return log;
}

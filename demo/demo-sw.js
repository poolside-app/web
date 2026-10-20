// =============================================================================
// demo-sw.js — the demo club inside the service worker (PLAN.md BG9)
// =============================================================================
// sw.js loads this only on demo.poolsideapp.com. Every call the pages make to
// Supabase is answered here from demo-data.js (made-up Maple Grove), so
// nothing reaches Poolside's servers, Twilio, Resend or Stripe, and the demo
// uses no calls. Each visitor's browser has its own copy; it starts over when
// the worker restarts or they tap "Start over".
//
// Pages from this site get demo-ui.js added as their first script: the demo
// banner, the demo's date (a June Saturday), the signed-in demo logins, and
// the notes that say what a button would have done in a real club.
// =============================================================================

importScripts('/demo/demo-data.js');
self.__DEMO__ = true;

let DEMO_STATE = {};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS' };
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });

// The made-up club is "maplegrove" in the video; here it lives at "demo".
const toDemoHost = s => s.replace(/"slug":"maplegrove"/g, '"slug":"demo"').replace(/maplegrove\.poolsideapp\.com/g, 'demo.poolsideapp.com');

self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'demo-reset') DEMO_STATE = {};
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.hostname.endsWith('.supabase.co')) { event.respondWith(answer(event)); return; }
  if (url.hostname === 'api.open-meteo.com') { event.respondWith(json(self.DemoSite.weather())); return; }
  if (event.request.mode === 'navigate' && url.origin === self.location.origin && !url.pathname.startsWith('/demo/') && url.pathname !== '/') {
    event.respondWith(withDemoUi(event.request));
  }
});

async function answer(event) {
  const req = event.request;
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const url = new URL(req.url);
  // Photo uploads and the like: accepted, nothing stored.
  if (url.pathname.includes('/storage/')) return json({ Key: 'demo/photo.jpg', path: 'demo/photo.jpg' });
  let body = {};
  try { body = await req.clone().json(); } catch (_) { /* not JSON */ }
  const fn = url.pathname.split('/').pop();
  const client = event.clientId ? await self.clients.get(event.clientId) : null;
  const side = client && /\/club\/admin\//.test(new URL(client.url).pathname) ? 'board' : 'family';
  let out;
  try { out = self.DemoSite.siteRespond(fn, body, { side, state: DEMO_STATE, pre: self.DEMO_PRE }); } catch (e) { out = { ok: true }; }
  const would = self.DemoSite.WOULD[`${fn}:${body.action}`];
  if (would && client) client.postMessage({ type: 'demo-would', text: would });
  return new Response(toDemoHost(JSON.stringify(out === undefined ? { ok: true } : out)), { headers: { 'content-type': 'application/json', ...CORS } });
}

async function withDemoUi(request) {
  const res = await fetch(request);
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.includes('text/html')) return res;
  const html = await res.text();
  const tag = '<script src="/demo/demo-ui.js"></script>';
  const out = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + tag) : tag + html;
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  return new Response(out, { status: res.status, headers });
}

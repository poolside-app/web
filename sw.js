// =============================================================================
// sw.js — Poolside service worker
// =============================================================================
// Minimal SW that exists so browsers (Chrome/Android) classify the site as
// installable. We do NOT attempt offline caching of dynamic content yet —
// the app is heavily Supabase-RPC driven and stale data would be more
// confusing than useful. The fetch handler is a thin pass-through.
//
// Push handlers are wired so when a tenant turns on push (push_admin) the
// notifications surface in the OS without a follow-up code change.
// =============================================================================

const CACHE_NAME = 'poolside-shell-v3';   // v3: the no-signal page (PLAN.md BG8)
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  // Activate immediately on first install so the user sees PWA behavior
  // without a hard refresh after registration. The one thing kept offline
  // is the no-signal page (PLAN.md BG8).
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.add(new Request(OFFLINE_URL, { cache: 'reload' }))).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop old caches if we ever bump CACHE_NAME.
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  // Everything passes through to the network as before. Only a page load
  // that fails (no signal at the pool) gets the no-signal page instead of
  // the browser's error (PLAN.md BG8). Data is never served from a cache.
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(async () =>
    (await caches.match(OFFLINE_URL)) || new Response('No signal right now. Your keyfob still works.', { headers: { 'content-type': 'text/plain' } })));
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* keep empty */ }
  const title = data.title || 'Poolside';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || 'poolside',
    renotify: !!data.renotify,
    data: { url: data.url || '/m/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target = (event.notification.data && event.notification.data.url) || '/m/';
  // The app opens to the board for board members (PLAN.md AH1); a member
  // pop-up says it's for the member side so it isn't sent on to the board.
  if (/^\/m(\/|$)/.test(target) && !/[?&]view=member/.test(target)) {
    const hash = target.indexOf('#') >= 0 ? target.slice(target.indexOf('#')) : '';
    const base = hash ? target.slice(0, target.indexOf('#')) : target;
    target = base + (base.includes('?') ? '&' : '?') + 'view=member' + hash;
  }
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(target) && 'focus' in c) return c.focus();
    }
    // The app is open on another page: bring it forward and go there,
    // instead of opening a second window (PLAN.md BG8).
    const open = all.find(c => 'focus' in c && 'navigate' in c);
    if (open) {
      try { const c = await open.focus(); await (c || open).navigate(target); return; } catch { /* fall back to a new window */ }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

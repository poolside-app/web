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

const CACHE_NAME = 'poolside-shell-v1';

self.addEventListener('install', (event) => {
  // Activate immediately on first install so the user sees PWA behavior
  // without a hard refresh after registration.
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
  // Pass-through. Some browsers require *some* fetch handler for the page to
  // count as installable; this is the lightest one that satisfies that bar.
  // Optimistic offline fallback for the start_url could go here later.
  return;
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
  const target = (event.notification.data && event.notification.data.url) || '/m/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.includes(target) && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

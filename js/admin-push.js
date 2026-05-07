/* =============================================================================
 * admin-push.js — Web Push opt-in/out for admin PWAs
 * =============================================================================
 * Exposes window.AdminPush with:
 *   .status()         → { supported, permission, subscribed }
 *   .subscribe()      → { ok, error? } — registers SW, asks permission,
 *                        creates push subscription, posts to push_admin
 *   .unsubscribe()    → { ok }
 *   .test()           → { ok, sent, failed } — fires a test notification
 *
 * Uses VAPID public key fetched from push_admin/vapid_public_key.
 * ============================================================================= */
(function () {
  'use strict';

  const SUPABASE_URL = 'https://sdewylbddkcvidwosgxo.supabase.co';
  const PUSH_URL = `${SUPABASE_URL}/functions/v1/push_admin`;

  function token() { return localStorage.getItem('poolside_tenant_token'); }

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  async function call(action, extra = {}) {
    const t = token();
    if (!t) return { ok: false, error: 'Not signed in' };
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': `Bearer ${t}` },
      body: JSON.stringify({ action, ...extra }),
    });
    return res.json();
  }

  async function status() {
    const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    if (!supported) return { supported: false, permission: 'unsupported', subscribed: false };
    const permission = Notification.permission;
    let subscribed = false;
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        subscribed = !!sub;
      }
    } catch (_) { /* leave subscribed=false */ }
    return { supported, permission, subscribed };
  }

  async function subscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, error: 'This browser doesn\'t support push notifications.' };
    }
    // Permission gate first — Safari/iOS will pop a system prompt.
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      return { ok: false, error: 'Notification permission was denied. Enable it in your browser/phone settings.' };
    }

    // Make sure /sw.js is registered with broad scope so push events fire on
    // any admin URL.
    let reg;
    try {
      reg = await navigator.serviceWorker.getRegistration('/');
      if (!reg) reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    } catch (e) {
      return { ok: false, error: 'Could not register service worker: ' + e.message };
    }

    // Fetch VAPID key from the function (it lives in env, not the static site).
    const keyRes = await call('vapid_public_key');
    if (!keyRes.ok) {
      return { ok: false, error: keyRes.error || 'Push notifications aren\'t configured yet on this server.' };
    }

    let sub;
    try {
      sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyRes.key),
        });
      }
    } catch (e) {
      return { ok: false, error: 'Could not subscribe: ' + e.message };
    }

    // POST the subscription to the server so it can push to it later.
    const json = sub.toJSON();
    const r = await call('subscribe', {
      endpoint: json.endpoint,
      p256dh:   json.keys?.p256dh,
      auth:     json.keys?.auth,
      user_agent: navigator.userAgent.slice(0, 240),
    });
    if (!r.ok) return { ok: false, error: r.error || 'Server rejected subscription' };
    return { ok: true };
  }

  async function unsubscribe() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      if (reg) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          // Tell the server first so it stops trying to push to a dead endpoint.
          await call('unsubscribe', { endpoint: sub.endpoint });
          await sub.unsubscribe();
        }
      }
    } catch (_) { /* best-effort */ }
    return { ok: true };
  }

  async function test() {
    return await call('test');
  }

  window.AdminPush = { status, subscribe, unsubscribe, test };
})();

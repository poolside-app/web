/* =============================================================================
 * admin-push.js — Web Push opt-in/out for admin PWAs
 * =============================================================================
 * Exposes window.AdminPush with:
 *   .status()         → { supported, permission, subscribed }
 *   .subscribe()      → { ok, error? } — registers SW, asks permission,
 *                        creates push subscription, posts to push_admin
 *   .unsubscribe()    → { ok }
 *   .test()           → { ok, sent, failed } — fires a test notification
 *   .mountPrompt(el, { mustFor?, devices? })
 *                      — a small "turn on pop-ups" card for the dashboard.
 *                        Settings (owner-only) has the full card; every
 *                        other board member only ever sees the dashboard.
 *                        mustFor = the member-help topics that come to this
 *                        person; with no device getting pop-ups (devices 0)
 *                        the card can't be dismissed, since pop-ups are the
 *                        only way they hear about a member's question.
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

  // Shares the "Not now" choice with the Settings card.
  const DISMISS_KEY = 'poolside_push_dismissed';
  function dismissed() { try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch (_) { return false; } }
  function dismiss() { try { localStorage.setItem(DISMISS_KEY, '1'); } catch (_) { /* private mode */ } }

  async function mountPrompt(el, opts = {}) {
    if (!el) return;
    const st = await status();
    const iphone = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const installed = navigator.standalone === true
      || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const topics = (opts.mustFor || []).join(', ');
    const must = !!topics && !(opts.devices > 0);
    if (st.subscribed || (!must && (st.permission === 'denied' || dismissed()))) { el.style.display = 'none'; return; }

    const btn = 'padding:8px 14px;border-radius:9px;font:600 13px Inter,sans-serif;cursor:pointer';
    const why = must
      ? `Members' <b>${esc(topics)}</b> questions come to you, but pop-ups aren't on for any of your devices, so you won't know when one arrives.`
      : 'Get a pop-up on this phone when something is for you, like a member\'s keyfob question.';
    const later = must ? '' : `<button type="button" data-act="later" style="${btn};background:transparent;color:#92400e;border:0">Not now</button>`;
    let body;
    if (st.supported && st.permission === 'denied') {
      body = `<div style="font-size:13.5px;line-height:1.45">${why} Pop-ups are blocked for this site on this device. Allow notifications for it in your phone or browser settings, then reload.</div>`;
    } else if (st.supported) {
      body = `<div style="font-size:13.5px;line-height:1.45;margin-bottom:10px">${why}</div>
        <button type="button" data-act="on" style="${btn};background:var(--blue,#1e40af);color:#fff;border:0">Turn on pop-ups</button>
        ${later}
        <div data-msg style="font-size:12px;color:#92400e;margin-top:8px;min-height:14px"></div>`;
    } else if (iphone && !installed) {
      body = `<div style="font-size:13.5px;line-height:1.45;margin-bottom:10px">${must ? why + ' ' : ''}To get pop-ups on iPhone: tap <b>Share</b>, then <b>Add to Home Screen</b>. Open the board app from your Home Screen and turn pop-ups on there.</div>
        ${must ? '' : `<button type="button" data-act="later" style="${btn};background:transparent;color:#92400e;border:1.5px solid #fde68a">Got it</button>`}`;
    } else if (must) {
      body = `<div style="font-size:13.5px;line-height:1.45">${why} This browser can't show pop-ups. Open the board app on your phone to turn them on.</div>`;
    } else {
      el.style.display = 'none';
      return;
    }
    el.innerHTML = `<div style="background:linear-gradient(135deg,#fff7ed,#fef3c7);border:1px solid #fde68a;border-radius:14px;padding:14px 16px;color:#78350f">📲 ${body}</div>`;
    el.style.display = '';
    el.addEventListener('click', async (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'later') { dismiss(); el.style.display = 'none'; }
      if (act === 'on') {
        e.target.disabled = true;
        const r = await subscribe();
        if (r.ok) { el.style.display = 'none'; return; }
        e.target.disabled = false;
        const msg = el.querySelector('[data-msg]');
        if (msg) msg.textContent = r.error || 'Could not turn on pop-ups.';
      }
    });
  }

  window.AdminPush = { status, subscribe, unsubscribe, test, mountPrompt };
})();

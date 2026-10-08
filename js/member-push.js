/* =============================================================================
 * member-push.js — pop-up notifications for members (PLAN.md N6)
 * =============================================================================
 * The member side of admin-push.js. Board replies, party decisions, plan
 * receipts and announcements pop up for members who turn this on.
 *
 *   MemberPush.mountPrompt(el)  — "Turn on notifications" card on the member
 *                                 home; hidden once on, or after "Not now"
 *   MemberPush.status()         → { supported, permission, subscribed }
 *   MemberPush.subscribe()      → { ok, error? }
 *
 * One browser keeps one push subscription per site, shared with the board app
 * on the same phone, so a subscription that already exists is registered for
 * this member too (once; remembered per member).
 * ============================================================================= */
(function () {
  'use strict';
  const PUSH_URL = 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/push_member';
  const token = () => localStorage.getItem('poolside_member_token');
  const memberId = () => { try { return JSON.parse(atob(token().split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub; } catch (_) { return ''; } };
  const REG_KEY = 'poolside_member_push_reg';
  const DISMISS_KEY = 'poolside_member_push_dismissed';
  const get = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } };

  function b64ToBytes(s) {
    const pad = '='.repeat((4 - s.length % 4) % 4);
    const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, c => c.charCodeAt(0));
  }
  async function call(action, extra = {}) {
    const t = token();
    if (!t) return { ok: false, error: 'Not signed in' };
    const r = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
      body: JSON.stringify({ action, ...extra }),
    });
    return r.json().catch(() => ({ ok: false }));
  }
  const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  async function browserSub() {
    try {
      const reg = await navigator.serviceWorker.getRegistration('/');
      return reg ? await reg.pushManager.getSubscription() : null;
    } catch (_) { return null; }
  }
  async function register(sub) {
    const j = sub.toJSON();
    const r = await call('subscribe', { endpoint: j.endpoint, p256dh: j.keys && j.keys.p256dh, auth: j.keys && j.keys.auth, user_agent: navigator.userAgent.slice(0, 240) });
    if (r.ok) set(REG_KEY, memberId() + '|' + j.endpoint);
    return r;
  }

  async function status() {
    if (!supported()) return { supported: false, permission: 'unsupported', subscribed: false };
    const sub = await browserSub();
    return { supported: true, permission: Notification.permission, subscribed: !!sub && Notification.permission === 'granted' };
  }

  async function subscribe() {
    if (!supported()) return { ok: false, error: 'This browser can\'t show notifications.' };
    let perm = Notification.permission;
    if (perm === 'default') perm = await Notification.requestPermission();
    if (perm !== 'granted') return { ok: false, error: 'Notifications are blocked. Allow them for this app in your phone\'s Settings.' };
    let reg;
    try {
      reg = await navigator.serviceWorker.getRegistration('/') || await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    } catch (e) { return { ok: false, error: 'Could not set up notifications: ' + e.message }; }
    const k = await call('vapid_public_key');
    if (!k.ok) return { ok: false, error: k.error || 'Notifications are not set up yet.' };
    let sub;
    try {
      sub = await reg.pushManager.getSubscription()
        || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
    } catch (e) { return { ok: false, error: 'Could not turn on notifications: ' + e.message }; }
    const r = await register(sub);
    return r.ok ? { ok: true } : { ok: false, error: r.error || 'Could not save it. Try again.' };
  }

  async function mountPrompt(el) {
    if (!el) return;
    const st = await status();
    // Already on in this browser: make sure it's registered for this member.
    if (st.subscribed) {
      const sub = await browserSub();
      if (sub && get(REG_KEY) !== memberId() + '|' + sub.endpoint) await register(sub);
      el.style.display = 'none';
      return;
    }
    if (get(DISMISS_KEY) === '1' || st.permission === 'denied') { el.style.display = 'none'; return; }
    const iphone = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const installed = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    const btn = 'padding:9px 15px;border-radius:10px;font:600 13px Inter,sans-serif;cursor:pointer';
    let body;
    if (st.supported) {
      body = `<div style="font-size:13.5px;line-height:1.45;margin-bottom:10px">Get a pop-up when the board answers you, your party is approved, a payment goes through, or the club posts news.</div>
        <button type="button" data-act="on" style="${btn};background:var(--blue,#0a3b5c);color:#fff;border:0">Turn on notifications</button>
        <button type="button" data-act="later" style="${btn};background:transparent;color:#92400e;border:0">Not now</button>
        <div data-msg style="font-size:12px;color:#92400e;margin-top:8px;min-height:14px"></div>`;
    } else if (iphone && !installed) {
      body = `<div style="font-size:13.5px;line-height:1.45;margin-bottom:10px">On iPhone, notifications work once the app is on your Home Screen (see "Add this club to your home screen" below). Open it from there and turn them on.</div>
        <button type="button" data-act="later" style="${btn};background:transparent;color:#92400e;border:1.5px solid #fde68a">Got it</button>`;
    } else { el.style.display = 'none'; return; }
    el.innerHTML = `<div style="background:linear-gradient(135deg,#fff7ed,#fef3c7);border:1px solid #fde68a;border-radius:14px;padding:14px 16px;color:#78350f;margin-bottom:14px">🔔 ${body}</div>`;
    el.style.display = '';
    el.onclick = async (e) => {
      const act = e.target && e.target.dataset && e.target.dataset.act;
      if (act === 'later') { set(DISMISS_KEY, '1'); el.style.display = 'none'; }
      if (act === 'on') {
        e.target.disabled = true;
        const r = await subscribe();
        if (r.ok) { el.innerHTML = '<div style="background:#dcfce7;border-radius:14px;padding:12px 16px;color:#14532d;font-size:13.5px;margin-bottom:14px">✓ Notifications are on.</div>'; return; }
        e.target.disabled = false;
        const m = el.querySelector('[data-msg]');
        if (m) m.textContent = r.error;
      }
    };
  }

  window.MemberPush = { status, subscribe, mountPrompt };
})();

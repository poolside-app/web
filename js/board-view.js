/* =============================================================================
 * board-view.js — the President's look-only preview of a board member's board
 * =============================================================================
 * PLAN.md CC (Doug 11/6): "is there a way i can see each board members board
 * page as i have selected their options..? just a view somehow?"
 *
 * Settings → Board's "See their view" opens /club/admin/#view=<sign-in>: a
 * one-hour, look-only sign-in for one board member (tenant_admin_auth
 * view_as). Loaded first on the board home, this file:
 *   - keeps that sign-in in this tab only, and gives the page this tab's own
 *     copy of everything it saves, so the President's own sign-in (other tabs,
 *     the Home Screen app) and saved things are never touched;
 *   - lets only the board home's reads go out (the same list as VIEW_READS in
 *     supabase/functions/_shared/board_view.ts, which the server enforces too)
 *     and answers anything else "look only" without sending it;
 *   - keeps the preview on their home: a tab, link or to-do shows the screens
 *     they can open instead (AdminNav.sectionsFor, the nav's own rules);
 *   - draws the bar on top: whose view it is, Their screens, Close.
 * Any other board page opened in a preview tab comes back here (admin-flags.js).
 * ============================================================================= */
(function () {
  'use strict';
  var KEY = 'poolside_view_token';
  var PFX = 'poolside_view:';
  var TOKEN = 'poolside_tenant_token';
  var BOARD_KEYS = [TOKEN, 'poolside_tenant_user', 'poolside_tenant_tenant'];
  var READS = { tenant_admin_auth: ['me'], admin_tasks: ['home', 'list', 'count'], tenant_settings: ['setup_status'] };
  var LOOK_ONLY = 'This is a look-only preview. Nothing can be changed from it.';
  var oGet = Storage.prototype.getItem, oSet = Storage.prototype.setItem, oDel = Storage.prototype.removeItem;
  var ss = null;
  try { ss = window.sessionStorage; } catch (_) { /* private mode: no preview */ }

  function tabKeys() {
    var out = [];
    try { for (var i = 0; i < ss.length; i++) { var k = ss.key(i); if (k === KEY || k.indexOf(PFX) === 0) out.push(k); } } catch (_) {}
    return out;
  }
  function clearTab() { tabKeys().forEach(function (k) { try { oDel.call(ss, k); } catch (_) {} }); }

  // A new preview starts this tab fresh, and the sign-in leaves the address.
  var m = /(?:^#|&)view=([^&]+)/.exec(location.hash || '');
  if (m && ss) {
    clearTab();
    try { oSet.call(ss, KEY, decodeURIComponent(m[1])); } catch (_) {}
    history.replaceState(null, '', location.pathname + location.search);
  }
  var tok = null;
  try { tok = ss ? oGet.call(ss, KEY) : null; } catch (_) { tok = null; }
  var wantScreens = location.hash === '#screens';
  if (wantScreens) history.replaceState(null, '', location.pathname + location.search);

  var me = null;   // the board member's `me`, once it arrives
  window.BoardView = { on: !!tok, close: close, screens: showScreens, me: function () { return me; } };
  if (!tok) return;

  // ── This tab's own storage ──────────────────────────────────────────────
  function isLocal(s) { try { return s === window.localStorage; } catch (_) { return false; } }
  var GONE = '\u0000';
  Storage.prototype.getItem = function (k) {
    if (!isLocal(this)) return oGet.call(this, k);
    k = String(k);
    if (k === TOKEN) return tok;
    var own = oGet.call(ss, PFX + k);
    if (own !== null) return own === GONE ? null : own;
    if (BOARD_KEYS.indexOf(k) >= 0) return null;   // never the President's own sign-in
    return oGet.call(this, k);
  };
  Storage.prototype.setItem = function (k, v) {
    if (!isLocal(this)) return oSet.call(this, k, v);
    k = String(k);
    if (k === TOKEN) return;   // a preview never takes on another sign-in
    oSet.call(ss, PFX + k, String(v));
  };
  Storage.prototype.removeItem = function (k) {
    if (!isLocal(this)) return oDel.call(this, k);
    oSet.call(ss, PFX + String(k), GONE);
  };
  Storage.prototype.clear = (function (oClear) {
    return function () { if (!isLocal(this)) return oClear.call(this); };
  })(Storage.prototype.clear);

  // ── Only the board home's reads go out ──────────────────────────────────
  function allowed(fn, action) {
    return Object.prototype.hasOwnProperty.call(READS, fn) && READS[fn].indexOf(action) >= 0;
  }
  function authOf(input, init) {
    var h = (init && init.headers) || (input && typeof input === 'object' && input.headers) || {};
    if (typeof h.get === 'function') return h.get('authorization') || '';
    for (var k in h) if (k.toLowerCase() === 'authorization') return h[k];
    return '';
  }
  var oFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var fm = /\/functions\/v1\/([a-z_]+)/.exec(url);
    if (!fm || authOf(input, init) !== 'Bearer ' + tok) return oFetch(input, init);
    var action = '';
    try { action = JSON.parse((init && init.body) || '{}').action || ''; } catch (_) { /* not JSON */ }
    if (!allowed(fm[1], action)) {
      toast();
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: LOOK_ONLY, look_only: true }),
        { status: 403, headers: { 'content-type': 'application/json' } }));
    }
    return oFetch(input, init).then(function (res) {
      // An hour is up: say so, and keep the page from signing anyone out.
      if (res.status === 401) { ended(); return new Promise(function () {}); }
      if (fm[1] === 'tenant_admin_auth' && action === 'me') {
        res.clone().json().then(function (d) {
          if (d && d.ok && d.user) { me = d; paintBar(); if (wantScreens) { wantScreens = false; showScreens(); } }
        }).catch(function () {});
      }
      return res;
    });
  };

  // ── Look, don't touch ───────────────────────────────────────────────────
  function home(path) { return /^\/club\/admin\/(index\.html)?$/.test(path); }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('#board-view-bar, #board-view-sheet')) return;
    if (t.closest('summary')) return;
    var a = t.closest('a[href]');
    if (a) {
      var href = a.getAttribute('href') || '';
      if (href === '#more') return;   // the bottom bar's More: its links come back here
      var u; try { u = new URL(a.href, location.href); } catch (_) { u = null; }
      if (u && u.origin === location.origin && home(u.pathname) && !u.hash) return;
      e.preventDefault(); e.stopPropagation();
      if (u && u.origin === location.origin && /^\/club\/admin\//.test(u.pathname)) showScreens(); else toast();
      return;
    }
    if (t.closest('button, [role="button"], input[type="submit"], [onclick], [data-href]')) {
      e.preventDefault(); e.stopPropagation();
      if (t.closest('[data-href]')) showScreens(); else toast();
    }
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); e.stopPropagation(); toast(); }, true);

  // ── The bar, the screens, the toast ─────────────────────────────────────
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  function css() {
    if (document.getElementById('board-view-css')) return;
    var st = document.createElement('style');
    st.id = 'board-view-css';
    st.textContent =
      '#board-view-bar{position:sticky;top:0;z-index:60;display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 16px;' +
        'background:#0a3b5c;color:#fff;font:500 14px Inter,system-ui,sans-serif;line-height:1.35}' +
      '#board-view-bar .bv-who{display:block;flex:1 1 220px;margin:0;color:#fff}#board-view-bar .bv-who b{display:inline;font-weight:700;color:#fff}' +
      '#board-view-bar .bv-btns{display:flex;gap:8px}' +
      '#board-view-bar button{padding:7px 12px;border-radius:9px;border:1.5px solid rgba(255,255,255,.55);background:transparent;color:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer}' +
      '#board-view-bar button.solid{background:#fff;color:#0a3b5c;border-color:#fff}' +
      '#board-view-sheet{position:fixed;inset:0;z-index:70;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}' +
      '#board-view-screens{background:#fff;width:100%;max-width:520px;max-height:85vh;overflow:auto;border-radius:18px 18px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));' +
        'font:400 14.5px Inter,system-ui,sans-serif;color:#0f172a}' +
      '#board-view-screens h3{margin:0 0 4px;font:600 18px Georgia,serif;color:#0a3b5c}' +
      '#board-view-screens .note{margin:0 0 12px;color:#64748b;font-size:13px;line-height:1.5}' +
      '#board-view-screens ul{margin:0 0 14px;padding:0;list-style:none}' +
      '#board-view-screens li{padding:9px 0;border-top:1px solid #e5e7eb}#board-view-screens li b{display:block;margin-bottom:2px}' +
      '#board-view-screens li span{color:#475569;font-size:13.5px}' +
      '#board-view-screens button{width:100%;padding:12px;border:0;border-radius:11px;background:#0a3b5c;color:#fff;font:600 14.5px Inter,system-ui,sans-serif;cursor:pointer}' +
      '#board-view-toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:80;max-width:92vw;' +
        'padding:10px 14px;border-radius:11px;background:#0f172a;color:#fff;font:500 13.5px Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)}';
    document.head.appendChild(st);
  }
  function firstName() { return ((me && me.user && (me.user.display_name || me.user.email)) || 'They').split(/[\s@]/)[0]; }
  function paintBar() {
    if (!document.body) return;
    css();
    var bar = document.getElementById('board-view-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'board-view-bar';
      document.body.insertBefore(bar, document.body.firstChild);
    }
    var u = (me && me.user) || {};
    var name = u.display_name || u.email || '…';
    var title = u.board_title ? ' · ' + u.board_title : '';
    bar.innerHTML = '<p class="bv-who">&#128065;&#xFE0E; Viewing as <b>' + esc(name) + '</b>' + esc(title) + '. Look only.</p>' +
      '<span class="bv-btns"><button type="button" class="solid" data-screens>Their screens</button><button type="button" data-close>Close</button></span>';
    bar.querySelector('[data-screens]').onclick = showScreens;
    bar.querySelector('[data-close]').onclick = close;
  }
  function sheet(html) {
    css();
    var old = document.getElementById('board-view-sheet');
    if (old) old.remove();
    var s = document.createElement('div');
    s.id = 'board-view-sheet';
    s.innerHTML = '<div id="board-view-screens" role="dialog" aria-modal="true">' + html + '</div>';
    s.addEventListener('click', function (e) { if (e.target === s || (e.target.closest && e.target.closest('[data-back]'))) s.remove(); });
    document.body.appendChild(s);
    return s;
  }
  function showScreens() {
    if (!me || !me.user) return;
    var secs = window.AdminNav ? window.AdminNav.sectionsFor(me.user, (me.tenant && me.tenant.features) || {}) : [];
    var n = firstName();
    sheet('<h3>' + esc(n) + ' can open:</h3>' +
      '<p class="note">Their screens look the same as yours. What’s different is which ones they can open, so the preview stays on their home.</p>' +
      '<ul>' + (secs.length ? secs.map(function (s) {
        return '<li><b>' + s.icon + ' ' + esc(s.label) + '</b><span>' + s.items.map(function (i) { return esc(i.label); }).join(', ') + '</span></li>';
      }).join('') : '<li>Only their home.</li>') + '</ul>' +
      '<button type="button" data-back>Back to ' + esc(n) + '’s home</button>');
  }
  var toastTimer = 0;
  function toast() {
    if (!document.body) return;
    css();
    var t = document.getElementById('board-view-toast');
    if (!t) { t = document.createElement('div'); t.id = 'board-view-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = 'Look only: nothing changes in a preview.';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.remove(); }, 2600);
  }
  function close() {
    clearTab();
    location.replace('/club/admin/board.html');
  }
  function ended() {
    clearTab();
    var s = sheet('<h3>This preview has ended</h3><p class="note">A preview lasts an hour. Open it again from Settings → Board.</p>' +
      '<button type="button" data-done>Back to Settings → Board</button>');
    s.querySelector('[data-done]').onclick = function () { location.replace('/club/admin/board.html'); };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paintBar); else paintBar();
})();

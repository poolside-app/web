/* =============================================================================
 * board-view.js — the President's look-only preview of a board member's or a
 * position's board
 * =============================================================================
 * PLAN.md CC (Doug 11/6): "is there a way i can see each board members board
 * page as i have selected their options..?", then "just see and interacti
 * with thier interface".
 *
 * Settings → Board's "See their view" / "See this position's view" opens
 * /club/admin/#view=<sign-in>: a one-hour, look-only sign-in (tenant_admin_auth
 * view_as). Loaded first on every board page, this file:
 *   - keeps that sign-in in this tab only, and gives the page this tab's own
 *     copy of everything it saves, so the President's own sign-in (other tabs,
 *     the Home Screen app) and saved things are never touched;
 *   - sends the reads worked out as them straight to their functions (READS,
 *     VIEW_READS in supabase/functions/_shared/board_view.ts), every other
 *     screen's reads through the board_preview relay (RELAY, PREVIEW_READS
 *     there), and answers anything else "look only" without sending it. The
 *     server refuses the same, so the lists only have to agree to work;
 *   - lets their tabs, quick buttons and to-dos open their screens; a screen
 *     they can't open says so; texting, calling and email links and the
 *     member side stay shut;
 *   - draws the bar on top: whose view it is, Their screens, Close.
 * A board page without this file, opened in a preview tab, comes back to the
 * preview's home (admin-flags.js).
 * ============================================================================= */
(function () {
  'use strict';
  var KEY = 'poolside_view_token';
  var PFX = 'poolside_view:';
  var TOKEN = 'poolside_tenant_token';
  var BOARD_KEYS = [TOKEN, 'poolside_tenant_user', 'poolside_tenant_tenant'];
  var READS = { tenant_admin_auth: ['me'], admin_tasks: ['home', 'list', 'count'], tenant_settings: ['setup_status'], help_requests: ['list', 'get', 'topics'] };
  var RELAY = {
    admin_tasks: ['time_saved'], applications: ['list', 'list_years', 'log', 'list_prefilled'], audit_admin: ['list'], board: ['get'],
    board_meetings: ['list', 'get', 'next', 'agenda', 'bylaws', 'list_active_admins'], donations: ['list'], email_templates: ['list', 'outbox'],
    events_admin: ['list'], external_calendar: ['list_feeds', 'list_public'], gate_admin: ['get_status', 'recent_unlocks', 'pass_list', 'pass_families'],
    google_drive_sync: ['status'], households_admin: ['list'], keyfobs: ['list', 'settings_get', 'sync_status'], lifeguards: ['list_shifts', 'list_roster'],
    parties_admin: ['list', 'settings_get'], payment_plans: ['config_get', 'upcoming', 'list_plans'],
    payments_admin: ['list', 'refund_reviews', 'venmo_waiting', 'codes_list'], photos_admin: ['list', 'list_pending', 'pending_count'], policies: ['list'],
    posts_admin: ['list'], programs: ['list', 'roster'], referrals: ['list'], renewals: ['renewal_audience', 'list_history', 'sms_usage'],
    sms_blasts: ['list', 'history'], sponsors_admin: ['list'], stripe_connect: ['status'], tenant_settings: ['get', 'season_status'], volunteer: ['list', 'roster'],
  };
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

  var me = null;   // their `me`, once it arrives
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

  // ── Their reads go out; nothing else does ───────────────────────────────
  function inList(list, fn, action) { return Object.prototype.hasOwnProperty.call(list, fn) && list[fn].indexOf(action) >= 0; }
  function authOf(input, init) {
    var h = (init && init.headers) || (input && typeof input === 'object' && input.headers) || {};
    if (typeof h.get === 'function') return h.get('authorization') || '';
    for (var k in h) if (k.toLowerCase() === 'authorization') return h[k];
    return '';
  }
  function lookOnly() {
    toast();
    return Promise.resolve(new Response(JSON.stringify({ ok: false, error: LOOK_ONLY, look_only: true }),
      { status: 403, headers: { 'content-type': 'application/json' } }));
  }
  var oFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var fm = /^(https:\/\/[^/]+\/functions\/v1\/)([a-z_]+)/.exec(url);
    if (!fm || authOf(input, init) !== 'Bearer ' + tok) return oFetch(input, init);
    var fn = fm[2], body = {};
    try { body = JSON.parse((init && init.body) || '{}') || {}; } catch (_) { return lookOnly(); }
    var action = String(body.action || '');
    var go;
    if (inList(READS, fn, action)) go = oFetch(input, init);
    else if (inList(RELAY, fn, action)) {
      delete body.action;
      go = oFetch(fm[1] + 'board_preview', { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
        body: JSON.stringify({ fn: fn, action: action, body: body }) });
    } else return lookOnly();
    return go.then(function (res) {
      // An hour is up: say so, and keep the page from signing anyone out.
      if (res.status === 401) { ended(); return new Promise(function () {}); }
      if (fn === 'tenant_admin_auth' && action === 'me') {
        res.clone().json().then(function (d) {
          if (d && d.ok && d.user) {
            me = d; paintBar(); checkPage();
            if (wantScreens) { wantScreens = false; showScreens(); }
          }
        }).catch(function () {});
      }
      return res;
    });
  };

  // ── Look around, don't touch ────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest || t.closest('#board-view-bar, #board-view-sheet, #board-view-cant')) return;
    var a = t.closest('a[href]');
    if (!a) return;   // buttons run; anything they'd change is stopped above
    var u; try { u = new URL(a.href, location.href); } catch (_) { return; }
    if (/^(tel|sms|mailto):/.test(u.protocol) || (u.origin === location.origin && !/^\/club\/admin\//.test(u.pathname))) {
      e.preventDefault(); e.stopPropagation(); toast();
    }
  }, true);
  // A form posting itself: nothing to send. (Their own handlers still run.)
  document.addEventListener('submit', function (e) { e.preventDefault(); }, true);

  // ── The bar, their screens, a screen they can't open ────────────────────
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
      '#board-view-sheet,#board-view-cant{position:fixed;inset:0;z-index:70;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}' +
      '#board-view-cant{z-index:55;background:#f8fafc;align-items:center}' +
      '.bv-card{background:#fff;width:100%;max-width:520px;max-height:85vh;overflow:auto;border-radius:18px 18px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));' +
        'font:400 14.5px Inter,system-ui,sans-serif;color:#0f172a;box-shadow:0 -6px 30px rgba(15,23,42,.12)}' +
      '#board-view-cant .bv-card{border-radius:18px;margin:16px}' +
      '.bv-card h3{margin:0 0 4px;font:600 18px Georgia,serif;color:#0a3b5c}' +
      '.bv-card .note{margin:0 0 12px;color:#64748b;font-size:13px;line-height:1.5}' +
      '.bv-card ul{margin:0 0 14px;padding:0;list-style:none}' +
      '.bv-card li{padding:9px 0;border-top:1px solid #e5e7eb}.bv-card li b{display:block;margin-bottom:4px}' +
      '.bv-card li a{display:inline-block;margin:0 10px 4px 0;color:#0a3b5c;font-weight:600;font-size:13.5px}' +
      '.bv-card button{width:100%;margin-top:8px;padding:12px;border:0;border-radius:11px;background:#0a3b5c;color:#fff;font:600 14.5px Inter,system-ui,sans-serif;cursor:pointer}' +
      '.bv-card button.ghost{background:#eef2f7;color:#0a3b5c}' +
      '#board-view-toast{position:fixed;left:50%;bottom:calc(84px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:80;max-width:92vw;' +
        'padding:10px 14px;border-radius:11px;background:#0f172a;color:#fff;font:500 13.5px Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.2)}';
    document.head.appendChild(st);
  }
  function isPosition() { return !!(me && me.user && me.user.viewing && me.user.viewing.position); }
  /** "Erik", or "The Facilities Director" for a position. */
  function who(cap) {
    var u = (me && me.user) || {};
    if (isPosition()) return (cap ? 'The ' : 'the ') + (u.display_name || 'position');
    return String(u.display_name || u.email || 'They').split(/[\s@]/)[0];
  }
  function features() { return (me && me.tenant && me.tenant.features) || {}; }
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
    var line = !me ? 'Loading their view…'
      : isPosition() ? 'Viewing as <b>' + esc(who(false)) + '</b>. Look only.'
      : 'Viewing as <b>' + esc(u.display_name || u.email) + '</b>' + esc(u.board_title ? ' · ' + u.board_title : '') + '. Look only.';
    bar.innerHTML = '<p class="bv-who">&#128065;&#xFE0E; ' + line + '</p>' +
      '<span class="bv-btns"><button type="button" class="solid" data-screens>Their screens</button><button type="button" data-close>Close</button></span>';
    bar.querySelector('[data-screens]').onclick = showScreens;
    bar.querySelector('[data-close]').onclick = close;
  }
  function sheet(id, html) {
    css();
    var old = document.getElementById(id);
    if (old) old.remove();
    var s = document.createElement('div');
    s.id = id;
    s.innerHTML = '<div class="bv-card" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(s);
    return s;
  }
  function sectionsHtml() {
    var secs = window.AdminNav ? window.AdminNav.sectionsFor(me.user, features()) : [];
    return '<ul><li><b>&#127968; Home</b><a href="/club/admin/">Their home</a></li>' + secs.map(function (s) {
      return '<li><b>' + s.icon + ' ' + esc(s.label) + '</b>' + s.items.map(function (i) { return '<a href="' + esc(i.href) + '">' + esc(i.label) + '</a>'; }).join('') + '</li>';
    }).join('') + '</ul>';
  }
  function showScreens() {
    if (!me || !me.user) return;
    var s = sheet('board-view-sheet', '<h3>' + esc(who(true)) + ' can open:</h3>' +
      '<p class="note">Tap any of them to open it, look only.</p>' + sectionsHtml() +
      '<button type="button" class="ghost" data-back>Close</button>');
    s.addEventListener('click', function (e) { if (e.target === s || (e.target.closest && e.target.closest('[data-back]'))) s.remove(); });
  }
  // A screen in the nav that isn't one of theirs.
  function checkPage() {
    if (!me || !window.AdminSections || !window.AdminNav) return;
    var path = location.pathname;
    if (/^\/club\/admin\/(index\.html)?$/.test(path)) return;
    var base = function (i) { return String(i.href).split('#')[0]; };
    var listed = false, theirs = false;
    Object.keys(window.AdminSections.SECTIONS).forEach(function (k) { window.AdminSections.SECTIONS[k].forEach(function (i) { if (base(i) === path) listed = true; }); });
    window.AdminNav.sectionsFor(me.user, features()).forEach(function (s) { s.items.forEach(function (i) { if (base(i) === path) theirs = true; }); });
    if (!listed || theirs) return;   // theirs, or a page reached from one of theirs
    var s = sheet('board-view-cant', '<h3>' + esc(who(true)) + ' can’t open this screen</h3>' +
      '<p class="note">It isn’t one of the screens you ticked for ' + (isPosition() ? 'this position' : 'them') + ' on Settings → Board, so it’s not in their tabs.</p>' +
      '<button type="button" data-back>Back</button><button type="button" class="ghost" data-list>Their screens</button>');
    s.querySelector('[data-back]').onclick = function () { if (history.length > 1) history.back(); else location.href = '/club/admin/'; };
    s.querySelector('[data-list]').onclick = showScreens;
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
    var s = sheet('board-view-sheet', '<h3>This preview has ended</h3><p class="note">A preview lasts an hour. Open it again from Settings → Board.</p>' +
      '<button type="button" data-done>Back to Settings → Board</button>');
    s.querySelector('[data-done]').onclick = function () { location.replace('/club/admin/board.html'); };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { paintBar(); checkPage(); });
  else paintBar();
})();

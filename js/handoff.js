/* =============================================================================
 * handoff.js — sign-ins that ride into a newly added Home Screen app
 * =============================================================================
 * An iPhone Home Screen app keeps its own storage, apart from Safari's, so a
 * freshly added app starts signed out. The member home has carried the
 * member's sign-in across since PLAN.md N2; Doug, 10/11: "if you are signed
 * in either member or board, it should bring both logins when saving the PWA
 * app" (PLAN.md AI).
 *
 * How: on an iPhone that hasn't added the app, the member home and the board
 * home keep a one-time sign-in ready for each sign-in this phone has
 * (member_auth / tenant_admin_auth `handoff`), and put them where the added
 * app will start: the manifest's start address and the page's own address
 * (?h= member, ?ah= board). iPhone reads the first manifest link it sees,
 * when it sees it, and ignores a later change, so the link is written now
 * if both are ready, or as soon as prepare() has them (8 seconds at most).
 * The new app, on first opening, trades them for sign-ins (consume()).
 *
 * Load synchronously in <head> (it writes the manifest link):
 *   <script src="/js/handoff.js"></script>
 * Then: await PoolsideHandoff.consume() first thing; PoolsideHandoff.prepare()
 * once the page knows who's signed in.
 * ============================================================================= */
(function () {
  'use strict';

  var FN = 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/';
  var KINDS = {
    member: { tok: 'poolside_member_token', user: 'poolside_member_user', tenant: 'poolside_member_tenant',
      cache: 'poolside_member_handoff', param: 'h', fn: 'member_auth', spare: 60 * 60000 },
    board: { tok: 'poolside_tenant_token', user: 'poolside_tenant_user', tenant: 'poolside_tenant_tenant',
      cache: 'poolside_admin_handoff', param: 'ah', fn: 'tenant_admin_auth', spare: 15 * 60000 },
  };
  var ORDER = ['member', 'board'];
  var BOARD_PAGE = /^\/club\/admin\//.test(location.pathname);
  var IPHONE = /iPad|iPhone|iPod/.test(navigator.userAgent);

  function get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function put(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } }
  function subOf(jwt) {
    try { return JSON.parse(atob(String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub || null; }
    catch (_) { return null; }
  }
  function standalone() {
    return navigator.standalone === true || !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches);
  }
  function slug() {
    var m = location.hostname.match(/^([a-z0-9][a-z0-9-]*)\.poolsideapp\.com$/i);
    return m && m[1] !== 'www' ? m[1] : '';
  }
  // A ready one-time sign-in for whoever is signed in here now, with time to spare.
  function ready(kind) {
    var k = KINDS[kind], t = get(k.tok);
    if (!t) return { need: false, token: null };
    var c = null;
    try { c = JSON.parse(get(k.cache) || 'null'); } catch (_) {}
    var fresh = c && c.token && c.sub === subOf(t) && c.exp > Date.now() + k.spare;
    return { need: true, token: fresh ? c.token : null };
  }
  function manifestHref(map) {
    var base = '/manifest.webmanifest' + (BOARD_PAGE ? '?admin=1' : '');
    var q = [];
    ORDER.forEach(function (kind) { if (map[kind]) q.push(KINDS[kind].param + '=' + encodeURIComponent(map[kind])); });
    return q.length ? base + (base.indexOf('?') >= 0 ? '&' : '?') + q.join('&') : base;
  }
  // iPhone starts the added app at the page's own address, so they go there too.
  function putInAddress(map) {
    try {
      var u = new URL(location.href), changed = false;
      ORDER.forEach(function (kind) {
        var p = KINDS[kind].param;
        if (map[kind] && u.searchParams.get(p) !== map[kind]) { u.searchParams.set(p, map[kind]); changed = true; }
      });
      if (changed) history.replaceState(null, '', u.pathname + u.search + u.hash);
    } catch (_) { /* the manifest still has them */ }
  }

  // ── Now, while the page is still being read: the manifest link ──
  var linked = false, timer = null, waiting = false, have = {};
  if (IPHONE && !standalone()) {
    ORDER.forEach(function (kind) {
      var r = ready(kind);
      if (!r.need) return;
      if (r.token) have[kind] = r.token; else waiting = true;
    });
  }
  function addManifestLink(href) {
    if (linked) return;
    linked = true;
    clearTimeout(timer);
    var l = document.createElement('link');
    l.rel = 'manifest';
    l.href = href;
    document.head.appendChild(l);
  }
  if (waiting) {
    // A sign-in is on its way (prepare); if it isn't here in 8 seconds, use what we have.
    timer = setTimeout(function () { addManifestLink(manifestHref(have)); }, 8000);
  } else {
    linked = true;
    document.write('<link rel="manifest" href="' + manifestHref(have) + '">');
    if (have.member || have.board) putInAddress(have);
  }

  // ── Once the page knows who's signed in: get any missing, then the link ──
  var preparing = null;
  function prepare() { return preparing || (preparing = doPrepare()); }   // once per page
  async function doPrepare() {
    if (!IPHONE || standalone()) return;
    var map = {};
    for (var i = 0; i < ORDER.length; i++) {
      var kind = ORDER[i], k = KINDS[kind], r = ready(kind);
      if (!r.need) continue;
      if (r.token) { map[kind] = r.token; continue; }
      try {
        var t = get(k.tok);
        var res = await fetch(FN + k.fn, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t },
          body: JSON.stringify({ action: 'handoff' }),
        }).then(function (x) { return x.json(); });
        if (res && res.ok && res.token) {
          map[kind] = res.token;
          put(k.cache, JSON.stringify({ token: res.token, exp: Date.parse(res.expires_at), sub: subOf(t) }));
        }
      } catch (_) { /* that side signs in by hand */ }
    }
    addManifestLink(manifestHref(map));
    if (map.member || map.board) putInAddress(map);
  }

  // ── In the newly added app, on first opening: sign in with them ──
  async function consume() {
    var u;
    try { u = new URL(location.href); } catch (_) { return; }
    var got = {};
    ORDER.forEach(function (kind) { got[kind] = u.searchParams.get(KINDS[kind].param); });
    if (!got.member && !got.board) return;
    var app = standalone();
    // Clean the address: always in the app; in a browser tab, unless it's
    // this phone's own (kept so Add to Home Screen picks it up). A sign-in
    // in a link someone shared is never used in a browser tab.
    var cleaned = false;
    ORDER.forEach(function (kind) {
      if (!got[kind]) return;
      var own = false;
      try { own = (JSON.parse(get(KINDS[kind].cache) || 'null') || {}).token === got[kind]; } catch (_) {}
      if (app || !own) { u.searchParams.delete(KINDS[kind].param); cleaned = true; }
    });
    if (cleaned) history.replaceState(null, '', u.pathname + u.search + u.hash);
    if (!app) return;
    var s = slug();
    if (got.member && !get(KINDS.member.tok)) {
      try {
        var m = await fetch(FN + 'member_auth', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'verify', slug: s, token: got.member }) }).then(function (x) { return x.json(); });
        if (m && m.ok && m.token) {
          put(KINDS.member.tok, m.token);
          put(KINDS.member.user, JSON.stringify(m.user || null));
          put(KINDS.member.tenant, JSON.stringify(m.tenant || null));
        }
      } catch (_) { /* falls back to the member sign-in page */ }
    }
    if (got.board && !get(KINDS.board.tok)) {
      try {
        var b = await fetch(FN + 'tenant_admin_auth', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'verify_link', slug: s, token: got.board }) }).then(function (x) { return x.json(); });
        if (b && b.ok && b.token) {
          put(KINDS.board.tok, b.token);
          put(KINDS.board.user, JSON.stringify(b.user || null));
          put(KINDS.board.tenant, JSON.stringify(b.tenant || null));
        }
      } catch (_) { /* falls back to the board sign-in page */ }
    }
  }

  window.PoolsideHandoff = { prepare: prepare, consume: consume };
  // The member home's older callers.
  window.addManifestLink = addManifestLink;
})();

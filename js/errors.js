/* =============================================================================
 * errors.js — catch JavaScript errors in production
 * =============================================================================
 * Until now nothing recorded a client-side error anywhere. frontend_smoke.mjs
 * catches them before a deploy; after a deploy, a member hitting a broken page
 * was invisible unless they emailed the board about it.
 *
 * Sends to Sentry when a DSN is configured below, and always keeps the last
 * few errors on window.__poolsideErrors so they can be read from devtools on
 * the actual phone that broke.
 *
 * SCRUBBING IS THE POINT, not an extra.
 * A member's sign-in token lives in the URL fragment of /m/verify.html, and
 * Sentry attaches the URL to every event by default. Shipping errors without
 * stripping that would mean posting working sign-in links for real families to
 * a third-party service, permanently, and calling it monitoring. Every URL is
 * cleaned before it leaves the page, and localStorage is never attached.
 * ============================================================================= */
(function () {
  'use strict';

  // ── config ────────────────────────────────────────────────────────────
  // Paste the DSN from Sentry → Settings → Projects → Client Keys.
  // Empty means Sentry is off; the local buffer below still works.
  var SENTRY_DSN = '';

  // Anything that looks like a credential gets replaced, in URLs and messages.
  var SECRET_KEYS = ['token', 'code', 'access_token', 'refresh_token', 'key',
                     'secret', 'password', 'pw', 'claim', 'session', 'jwt', 'otp'];

  var MAX_KEPT = 20;      // ring buffer in the page
  var MAX_SENT = 10;      // per page load, so a render loop cannot spam Sentry

  var kept = [];
  var sentCount = 0;
  var seen = {};

  window.__poolsideErrors = kept;
  // Exposed so scripts/errors_test.mjs can check the scrubbing without a
  // browser. Both are pure string functions and reveal nothing by being here;
  // the scrubbing is the part that must never silently regress.
  window.__poolsideScrub = { url: scrubUrl, text: scrubText };

  // ── scrubbing ─────────────────────────────────────────────────────────
  function scrubUrl(raw) {
    if (!raw) return raw;
    try {
      var u = new URL(raw, window.location.origin);
      SECRET_KEYS.forEach(function (k) {
        if (u.searchParams.has(k)) u.searchParams.set(k, '[redacted]');
      });
      // The fragment is where magic-link tokens actually live: #token=...
      if (u.hash && /(^|[#&])(token|code|key|jwt|otp)=/i.test(u.hash)) {
        u.hash = '#[redacted]';
      }
      return u.toString();
    } catch (_) {
      return String(raw).replace(/([?&#](?:token|code|key|jwt|otp)=)[^&]*/gi, '$1[redacted]');
    }
  }

  function scrubText(s) {
    if (!s) return s;
    return String(s)
      .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, '[jwt]')                 // any JWT
      .replace(/\b\d{6}\b/g, '[code]')                                 // 6-digit sign-in codes
      .replace(/\b[\w.%+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, '[email]')
      .replace(/\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g, '[phone]')
      .slice(0, 1000);
  }

  // Which surface broke — a member page failing matters differently from an
  // admin one, and the club is worth knowing without any member data.
  function surface() {
    var p = window.location.pathname;
    if (p.indexOf('/club/admin/') === 0) return 'club-admin';
    if (p.indexOf('/admin/') === 0) return 'provider-admin';
    if (p.indexOf('/m/') === 0) return 'member';
    if (p.indexOf('/club/') === 0) return 'club-public';
    return 'public';
  }
  function clubSlug() {
    var h = window.location.hostname.split('.');
    return (h.length > 2 && h[0] !== 'www') ? h[0] : '(apex)';
  }

  function record(kind, message, extra) {
    var e = {
      at: new Date().toISOString(),
      kind: kind,
      message: scrubText(message),
      url: scrubUrl(window.location.href),
      surface: surface(),
      club: clubSlug(),
    };
    if (extra) {
      if (extra.source) e.source = scrubUrl(extra.source);
      if (extra.line) e.line = extra.line;
      if (extra.stack) e.stack = scrubText(extra.stack);
    }
    kept.push(e);
    while (kept.length > MAX_KEPT) kept.shift();
    return e;
  }

  // ── Sentry ────────────────────────────────────────────────────────────
  function initSentry() {
    if (!SENTRY_DSN) return;
    var key;
    try { key = SENTRY_DSN.split('//')[1].split('@')[0]; } catch (_) { return; }
    if (!key) return;

    var s = document.createElement('script');
    s.src = 'https://js.sentry-cdn.com/' + key + '.min.js';
    s.crossOrigin = 'anonymous';
    s.onload = function () {
      if (!window.Sentry || !window.Sentry.onLoad) return;
      window.Sentry.onLoad(function () {
        window.Sentry.init({
          dsn: SENTRY_DSN,
          // No session replay, no performance tracing, no auto PII. This is a
          // pool club: the only thing worth shipping is "what broke, where".
          sendDefaultPii: false,
          replaysSessionSampleRate: 0,
          replaysOnErrorSampleRate: 0,
          tracesSampleRate: 0,
          initialScope: { tags: { surface: surface(), club: clubSlug() } },
          beforeSend: function (event) {
            if (sentCount >= MAX_SENT) return null;
            sentCount++;
            try {
              if (event.request && event.request.url) event.request.url = scrubUrl(event.request.url);
              if (event.request) { delete event.request.cookies; delete event.request.headers; }
              if (event.message) event.message = scrubText(event.message);
              if (event.exception && event.exception.values) {
                event.exception.values.forEach(function (v) {
                  if (v.value) v.value = scrubText(v.value);
                });
              }
              (event.breadcrumbs || []).forEach(function (b) {
                if (b.data && b.data.url) b.data.url = scrubUrl(b.data.url);
                if (b.message) b.message = scrubText(b.message);
              });
            } catch (_) { return null; }   // if scrubbing fails, send nothing
            return event;
          },
        });
      });
    };
    s.onerror = function () { /* monitoring must never be the thing that breaks */ };
    document.head.appendChild(s);
  }

  // ── capture ───────────────────────────────────────────────────────────
  // These run regardless of Sentry, so window.__poolsideErrors is populated
  // even before a DSN is configured.
  window.addEventListener('error', function (ev) {
    try {
      var msg = ev.message || (ev.error && ev.error.message) || 'Unknown error';
      var sig = msg + '@' + (ev.lineno || 0);
      if (seen[sig]) return; seen[sig] = 1;    // one of each per page load
      record('error', msg, {
        source: ev.filename, line: ev.lineno,
        stack: ev.error && ev.error.stack,
      });
    } catch (_) { /* never throw from the handler */ }
  });

  window.addEventListener('unhandledrejection', function (ev) {
    try {
      var r = ev.reason;
      var msg = (r && (r.message || r)) || 'Unhandled promise rejection';
      var sig = 'rej:' + msg;
      if (seen[sig]) return; seen[sig] = 1;
      record('unhandledrejection', msg, { stack: r && r.stack });
    } catch (_) { /* never throw from the handler */ }
  });

  initSentry();
})();

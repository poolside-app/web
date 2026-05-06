// =============================================================================
// pwa.js — shared PWA install wiring used by m/, club/, apply
// =============================================================================
// Each page that wants to be installable as an app loads this script and
// calls `setupPwa({ branding, displayName })` once it has the tenant's
// branding from tenant_public.
//
// Responsibilities:
//   - Set <link rel="apple-touch-icon"> href to the tenant's 192px icon
//     (iOS Safari uses this for the home-screen icon; manifest is mostly
//     ignored on iOS.)
//   - Set <meta name="theme-color"> to the tenant's primary color (Android
//     status-bar tint when launched standalone).
//   - Set <meta name="apple-mobile-web-app-title"> to the club's display
//     name so the home-screen label matches the brand.
//   - Register /sw.js so Chrome classifies the site as installable.
//
// The pages must include in <head>:
//   <link rel="manifest" href="/manifest.webmanifest">
//   <link rel="apple-touch-icon" id="apple-touch-icon" href="">
//   <meta name="theme-color" id="meta-theme-color" content="#0a3b5c">
//   <meta name="apple-mobile-web-app-capable" content="yes">
//   <meta name="apple-mobile-web-app-status-bar-style" content="default">
//   <meta name="apple-mobile-web-app-title" id="meta-apple-title" content="Poolside">
// =============================================================================

(function () {
  'use strict';

  const DEFAULT_ICON_192 = 'https://poolsideapp.com/icon-192.png';

  function setEl(id, attr, value) {
    const el = document.getElementById(id);
    if (el && value != null) el.setAttribute(attr, value);
  }

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           window.navigator.standalone === true;
  }

  function detectPlatform() {
    const ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) && !window.MSStream) return 'ios';
    if (/Android/.test(ua)) return 'android';
    return 'other';
  }

  // Capture the Android `beforeinstallprompt` event so a button can later
  // call .prompt() instead of forcing the user to dig through Chrome's menu.
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    document.dispatchEvent(new CustomEvent('pwa-installable'));
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    document.dispatchEvent(new CustomEvent('pwa-installed'));
  });

  function showAndroidInstall() {
    if (!deferredInstallPrompt) return Promise.resolve(false);
    deferredInstallPrompt.prompt();
    return deferredInstallPrompt.userChoice.then((res) => {
      deferredInstallPrompt = null;
      return res.outcome === 'accepted';
    });
  }

  // Public API
  window.Pwa = {
    isStandalone,
    detectPlatform,
    canPromptInstall: () => !!deferredInstallPrompt,
    promptInstall: showAndroidInstall,

    setup: function (opts) {
      const branding   = (opts && opts.branding)    || {};
      const displayName = (opts && opts.displayName) || 'Poolside';

      const themeColor = branding.primary_color || '#0a3b5c';
      const icon192    = branding.icon_192_url || DEFAULT_ICON_192;

      setEl('apple-touch-icon',  'href',    icon192);
      setEl('meta-theme-color',  'content', themeColor);
      setEl('meta-apple-title',  'content', displayName);

      // Register the SW from the root scope so it's shared across /m/, /club/,
      // /apply.html etc. Path is /sw.js — Vercel serves it at that root URL.
      if ('serviceWorker' in navigator) {
        // Defer registration until after load so we don't race the page's own
        // critical fetches.
        if (document.readyState === 'complete') {
          navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
        } else {
          window.addEventListener('load', () => {
            navigator.serviceWorker.register('/sw.js').catch(() => { /* non-fatal */ });
          });
        }
      }
    },
  };
})();

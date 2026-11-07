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
//   <link rel="apple-touch-icon" id="apple-touch-icon" href="/apple-touch-icon.png">
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

  // ── Install guide ─────────────────────────────────────────────────────
  // "Add to home screen" is the difference between an app someone opens and a
  // bookmark they lose. The steps differ per browser, and on iOS every browser
  // reports "iPhone", so Chrome users were being shown Safari's instructions
  // (share button at the bottom) which simply is not there for them.
  //
  // Lives here so every surface that should offer it — after paying, after
  // activating, on the member home — shows the same thing.
  function detectInstallEnv() {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
    if (ios) return /CriOS|FxiOS|EdgiOS/.test(ua) ? 'ios-chrome' : 'ios-safari';
    if (/Android/.test(ua)) return 'android';
    return 'desktop';
  }

  const INSTALL_INSTR = {
    // Since iOS 26, Share is behind ••• next to the address bar (PLAN.md CA1).
    'ios-safari': '<ol class="pwa-steps"><li>Tap <b>•••</b> next to the address bar, then <b>Share</b>. (On older iPhones, <b>Share</b> <span class="pwa-ic">&#8593;</span> is at the bottom of Safari.)</li><li>Scroll down and tap <b>Add to Home Screen</b>.</li><li>Leave <b>Open as Web App</b> on and tap <b>Add</b>.</li></ol>',
    'ios-chrome': '<ol class="pwa-steps"><li>Tap the <b>Share</b> icon <span class="pwa-ic">&#8593;</span> near the address bar (<b>top-right</b>).</li><li>Tap <b>Add to Home Screen</b>.</li><li>Tap <b>Add</b>.</li></ol><p class="pwa-hint">Don\u2019t see it? Open this page in <b>Safari</b> and try again.</p>',
    'android': '<div class="pwa-android-slot"></div><ol class="pwa-steps"><li>Or tap Chrome\u2019s <b>&#8942;</b> menu (top-right).</li><li>Tap <b>Add to Home screen</b> (or <b>Install app</b>).</li></ol>',
  };

  // A short video under the written steps, for anyone who'd rather watch
  // (PLAN.md CA4). Hosted next to the pages; written by
  // scripts/demo_video/homescreen.mjs. Chrome on an iPhone gets the iPhone
  // one: its steps already send people to Safari.
  const INSTALL_VIDEO = {
    'ios-safari': { src: '/videos/add-app-iphone.mp4', secs: 48 },
    'ios-chrome': { src: '/videos/add-app-iphone.mp4', secs: 48 },
    'android':    { src: '/videos/add-app-android.mp4', secs: 42 },
  };

  function installVideoHtml(env) {
    const v = INSTALL_VIDEO[env];
    if (!v) return '';
    ensureInstallCss();
    return '<div class="pwa-vbox"><button type="button" class="pwa-watch" data-src="' + v.src + '">' +
      '&#9654;&#xFE0E; Watch a ' + v.secs + '-second video</button></div>';
  }

  // Tapping plays it right there. No playsinline, so an iPhone plays it full
  // screen (it's a wide video); Android plays it in the card with a full-screen button.
  function wireInstallVideo(root) {
    if (!root) return;
    root.querySelectorAll('.pwa-watch').forEach(function (btn) {
      if (btn.dataset.wired) return;
      btn.dataset.wired = '1';
      btn.addEventListener('click', function () {
        const box = btn.parentNode;
        const v = document.createElement('video');
        v.className = 'pwa-vid';
        v.controls = true;
        v.preload = 'auto';
        v.setAttribute('src', btn.dataset.src);
        box.replaceChild(v, btn);
        const p = v.play();
        if (p && p.catch) p.catch(function () { /* they can press play */ });
      });
    });
  }

  const INSTALL_CSS = `
    .pwa-install{margin-top:18px;padding:16px 18px;background:#f7f3eb;border-radius:14px}
    .pwa-install h3{margin:0 0 4px;font:600 16px Georgia,serif;color:#0a3b5c}
    .pwa-install .pwa-lede{margin:0 0 10px;font-size:13px;color:#64748b;line-height:1.5}
    .pwa-bpick{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    .pwa-btab{padding:6px 11px;border:1.5px solid #e5e7eb;background:#fff;border-radius:999px;
      font:600 12px Inter,system-ui,sans-serif;color:#0f172a;cursor:pointer}
    .pwa-btab.on{background:#0a3b5c;border-color:#0a3b5c;color:#fff}
    .pwa-steps{margin:0;padding-left:20px;font-size:14px;line-height:1.7;color:#0f172a}
    .pwa-ic{display:inline-block;padding:0 5px;border:1px solid #cbd5e1;border-radius:5px;font-size:12px}
    .pwa-hint{margin:8px 0 0;font-size:12.5px;color:#64748b}
    .pwa-vbox{margin-top:10px}
    button.pwa-watch{padding:0;border:0;background:none;font:600 14px Inter,system-ui,sans-serif;color:#0a3b5c;
      text-decoration:underline;text-underline-offset:3px;cursor:pointer}
    .pwa-vid{display:block;width:100%;border-radius:10px;background:#0a3b5c}
    .pwa-install button.pwa-install-btn{margin:0 0 8px;padding:11px 20px;border:0;border-radius:10px;
      background:#0a3b5c;color:#fff;font:600 14px Inter,system-ui,sans-serif;cursor:pointer}
  `;

  function ensureInstallCss() {
    if (document.getElementById('pwa-install-css')) return;
    const st = document.createElement('style');
    st.id = 'pwa-install-css';
    st.textContent = INSTALL_CSS;
    document.head.appendChild(st);
  }

  function mountAndroidBtn(root) {
    const slot = root.querySelector('.pwa-android-slot');
    if (!slot || !deferredInstallPrompt) return;
    slot.innerHTML = '<button type="button" class="pwa-install-btn">Add to home screen</button>';
    slot.querySelector('button').addEventListener('click', showAndroidInstall);
  }

  /**
   * Render the guide into `host`. Returns false (and renders nothing) when the
   * page is already running installed — nobody needs to be told to install the
   * thing they are inside.
   */
  function renderInstallGuide(host, opts) {
    if (!host) return false;
    if (isStandalone()) { host.innerHTML = ''; return false; }
    ensureInstallCss();
    const env = detectInstallEnv();
    const title = (opts && opts.title) || 'Put it on your home screen';
    const lede = (opts && opts.lede)
      || 'One tap to check pool hours, book a party, or pay — no hunting for a link.';

    if (env === 'desktop') {
      host.innerHTML = '<div class="pwa-install"><h3>&#128241; ' + title + '</h3>' +
        '<div class="pwa-android-slot"></div>' +
        '<p class="pwa-lede">Open this page on your phone, then add it to the home screen.</p></div>';
      mountAndroidBtn(host);
      return true;
    }

    const tabs = [['ios-safari', 'iPhone \u00b7 Safari'], ['ios-chrome', 'iPhone \u00b7 Chrome'], ['android', 'Android']];
    host.innerHTML = '<div class="pwa-install"><h3>&#128241; ' + title + '</h3>' +
      '<p class="pwa-lede">' + lede + '</p>' +
      '<div class="pwa-bpick">' +
        tabs.map(function (t) {
          return '<button type="button" class="pwa-btab' + (t[0] === env ? ' on' : '') + '" data-b="' + t[0] + '">' + t[1] + '</button>';
        }).join('') +
      '</div><div class="pwa-instr">' + (INSTALL_INSTR[env] || INSTALL_INSTR['ios-safari']) + '</div>' +
      '<div class="pwa-video">' + installVideoHtml(INSTALL_INSTR[env] ? env : 'ios-safari') + '</div></div>';

    // Detection is a guess, so the tabs are the escape hatch: a member whose
    // steps do not match what they see can switch and still get there.
    host.querySelectorAll('.pwa-btab').forEach(function (b) {
      b.addEventListener('click', function () {
        host.querySelectorAll('.pwa-btab').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        host.querySelector('.pwa-instr').innerHTML = INSTALL_INSTR[b.dataset.b];
        host.querySelector('.pwa-video').innerHTML = installVideoHtml(b.dataset.b);
        wireInstallVideo(host);
        mountAndroidBtn(host);
      });
    });
    wireInstallVideo(host);
    mountAndroidBtn(host);
    return true;
  }

  // The name under the app icon (PLAN.md AC1): the club's own
  // (branding.app_name), or whole words of its name up to 12 characters.
  // Same rule as supabase/functions/_shared/app_name.ts.
  function homeName(displayName, appName) {
    const own = String(appName == null ? '' : appName).trim();
    if (own) return own;
    const words = String(displayName == null ? '' : displayName).trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'Poolside';
    let out = '';
    for (const w of words) {
      const next = out ? out + ' ' + w : w;
      if (next.length > 12) break;
      out = next;
    }
    return out || words[0].slice(0, 12);
  }

  window.Pwa = {
    homeName,
    isStandalone,
    detectPlatform,
    detectInstallEnv,
    renderInstallGuide,
    installVideoHtml,
    wireInstallVideo,
    canPromptInstall: () => !!deferredInstallPrompt,
    promptInstall: showAndroidInstall,

    setup: function (opts) {
      const branding   = (opts && opts.branding)    || {};
      const displayName = (opts && opts.displayName) || 'Poolside';

      const themeColor = branding.primary_color || '#0a3b5c';
      const icon192    = branding.icon_192_url || DEFAULT_ICON_192;

      setEl('apple-touch-icon',  'href',    icon192);
      setEl('meta-theme-color',  'content', themeColor);
      setEl('meta-apple-title',  'content', homeName(displayName, branding.app_name));

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

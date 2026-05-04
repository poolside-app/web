/* =============================================================================
 * PoolsideHelpFab — small floating "?" button on every admin page
 * =============================================================================
 * The Help link lives at position 11 of 12 in a horizontally-scrolling tab
 * strip on mobile. New admins were swiping right and never finding it.
 *
 * This script injects a fixed-position "?" button in the bottom-right of every
 * admin page, opening /club/admin/help.html in the same tab. It self-skips on
 * the help page itself, on login, and on the wizard (where the user is being
 * walked through setup and an extra button would be noise).
 *
 * Accessibility:
 *   - real <button> with aria-label and title
 *   - 48x48px hit target (above WCAG 2.5.5 minimum)
 *   - visible focus ring
 *   - no animation under prefers-reduced-motion
 * ============================================================================= */
(function () {
  'use strict';
  try {
    var path = (window.location.pathname || '').toLowerCase();
    // Don't render on the help page itself, on login, or in the setup wizard
    if (path.endsWith('/club/admin/help.html')) return;
    if (path.endsWith('/club/admin/login.html')) return;
    if (path.indexOf('/club/wizard') !== -1) return;

    if (document.getElementById('poolside-help-fab')) return;

    var inject = function () {
      // Inject CSS once
      if (!document.getElementById('poolside-help-fab-css')) {
        var style = document.createElement('style');
        style.id = 'poolside-help-fab-css';
        style.textContent = ''
          + '#poolside-help-fab{'
          +   'position:fixed;right:16px;bottom:16px;z-index:9999;'
          +   'width:48px;height:48px;border-radius:50%;'
          +   'background:#0a3b5c;color:#fff;border:0;cursor:pointer;'
          +   'font:600 22px/1 "Fraunces",Georgia,serif;'
          +   'box-shadow:0 4px 14px rgba(10,59,92,.28),0 1px 3px rgba(0,0,0,.12);'
          +   'display:inline-flex;align-items:center;justify-content:center;'
          +   'text-decoration:none;'
          +   'transition:transform .15s,box-shadow .15s,background .15s;'
          + '}'
          + '#poolside-help-fab:hover{background:#134b73;transform:translateY(-1px);box-shadow:0 6px 18px rgba(10,59,92,.36)}'
          + '#poolside-help-fab:focus-visible{outline:3px solid #f59e0b;outline-offset:2px}'
          + '#poolside-help-fab .label{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}'
          + '@media (prefers-reduced-motion: reduce){#poolside-help-fab{transition:none}#poolside-help-fab:hover{transform:none}}'
          // Mobile: scoot up so it doesn't sit on top of any sticky bottom bar
          + '@media (max-width: 600px){#poolside-help-fab{right:12px;bottom:12px;width:52px;height:52px;font-size:24px}}';
        document.head.appendChild(style);
      }
      var a = document.createElement('a');
      a.id = 'poolside-help-fab';
      a.href = '/club/admin/help.html';
      a.setAttribute('aria-label', 'Open help center');
      a.setAttribute('title', 'Help (open help center)');
      // Question-mark glyph; aria-label carries the meaning for screen readers
      a.innerHTML = '?<span class="label">Help</span>';
      // Track FAB clicks so we know which admin pages drive admins into the
      // help center most. Fire-and-forget; uses keepalive so the request
      // survives the navigation that the click triggers.
      a.addEventListener('click', function () {
        try {
          var t = localStorage.getItem('poolside_tenant_token');
          if (!t) return;
          fetch('https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/help_track', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + t },
            body: JSON.stringify({
              event_type: 'fab_clicked',
              page_referrer: location.pathname + location.search,
            }),
            keepalive: true,
          }).catch(function () { /* ignore */ });
        } catch (_) { /* ignore */ }
      });
      document.body.appendChild(a);

      // Hide while a modal scrim is open (every admin modal uses .scrim.open or
      // .modal-bg with display:flex). A 48x48 floating button hovering above an
      // open dialog covers the close button on mobile and is just visual noise.
      var fab = a;
      var setHidden = function () {
        var modalOpen = !!(
          document.querySelector('.scrim.open') ||
          document.querySelector('.scrim[style*="display: flex"]') ||
          document.querySelector('.modal-bg[style*="display: flex"]') ||
          document.querySelector('.modal-bg[style*="display:flex"]')
        );
        fab.style.display = modalOpen ? 'none' : '';
      };
      try {
        var mo = new MutationObserver(setHidden);
        mo.observe(document.body, {
          attributes: true,
          subtree: true,
          attributeFilter: ['class', 'style'],
          childList: true,
        });
      } catch (_) { /* old browser — fall through, FAB stays visible */ }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', inject, { once: true });
    } else {
      inject();
    }
  } catch (e) {
    // Help button is non-critical; never break a page over it
    if (window.console) console.warn('[help-fab]', e);
  }
})();

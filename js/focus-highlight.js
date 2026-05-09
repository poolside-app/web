/* =============================================================================
 * focus-highlight.js — pulse + scroll-into-view a target field when arriving
 *                       from the setup checklist
 * =============================================================================
 * Pages link from /club/admin/setup.html with `?focus=<name>`. The target
 * page declares which DOM nodes correspond to which focus name via a
 * `data-focus="<name>"` attribute. This script reads ?focus, finds matching
 * nodes, scrolls them into view, and adds a pulsing highlight ring.
 *
 * Supports a fallback selector via window.FOCUS_FALLBACKS = { focusName: 'css selector' }
 * for pages that can't easily annotate their existing markup.
 * ============================================================================= */
(function () {
  'use strict';

  function inject() {
    if (document.getElementById('focus-highlight-css')) return;
    const s = document.createElement('style');
    s.id = 'focus-highlight-css';
    s.textContent = `
      .focus-highlight {
        animation: focus-pulse 1.4s ease-in-out 4;
        scroll-margin-top: 80px;
        border-radius: 12px;
        position: relative;
      }
      @keyframes focus-pulse {
        0%, 100% { box-shadow: 0 0 0 0 rgba(245, 158, 11, .9); }
        50%      { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .focus-highlight { animation: none; outline: 3px solid #f59e0b; outline-offset: 4px; }
      }
    `;
    document.head.appendChild(s);
  }

  function highlight(name) {
    if (!name) return;
    inject();
    // Try data-focus attribute first, then any custom fallback selector
    let nodes = document.querySelectorAll(`[data-focus="${CSS.escape(name)}"]`);
    if (!nodes.length && window.FOCUS_FALLBACKS && window.FOCUS_FALLBACKS[name]) {
      nodes = document.querySelectorAll(window.FOCUS_FALLBACKS[name]);
    }
    if (!nodes.length) return;
    const target = nodes[0];
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    nodes.forEach(n => {
      n.classList.add('focus-highlight');
      // Best-effort: focus the first input/textarea inside
      const fld = n.tagName.match(/^(INPUT|TEXTAREA|SELECT)$/i) ? n : n.querySelector('input, textarea, select, button');
      if (fld) {
        try { fld.focus({ preventScroll: true }); } catch (_) { /* ignore */ }
      }
    });
    // Strip the ?focus param from URL so reload doesn't re-pulse
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('focus');
      history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
    } catch (_) { /* ignore */ }
  }

  function run() {
    const params = new URLSearchParams(window.location.search);
    const name = params.get('focus');
    if (!name) return;
    // Defer one tick so any page-specific render (e.g. tenant settings load)
    // has a chance to populate the DOM. 600ms is enough for typical fetches.
    setTimeout(() => highlight(name), 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();

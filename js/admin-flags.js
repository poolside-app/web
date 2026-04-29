/* =============================================================================
 * PoolsideFlags — apply per-tenant feature flags to admin nav + UI elements
 * =============================================================================
 * Usage: every admin page already calls tenant_admin_auth.me on init.
 * After it returns, call:
 *
 *   PoolsideFlags.apply(me.tenant.features || {});
 *
 * Hides nav links + UI elements when the corresponding feature is explicitly
 * false. Default behavior: feature is on unless toggled off.
 * ============================================================================= */
(function () {
  'use strict';

  const NAV_FLAGS = {
    parties:       'a[href="/club/admin/parties.html"]',
    swim_lessons:  'a[href="/club/admin/swim_lessons.html"]',  // future
  };

  function apply(features) {
    features = features || {};
    for (const [flag, selector] of Object.entries(NAV_FLAGS)) {
      if (features[flag] === false) {
        document.querySelectorAll(selector).forEach(el => { el.style.display = 'none'; });
      }
    }
    // Keyfob field on households
    if (features.keyfobs === false) {
      document.querySelectorAll('[data-feature="keyfobs"]').forEach(el => { el.style.display = 'none'; });
    }
    // Allow other UI to read state via a body data attribute too
    if (typeof features === 'object') {
      document.body.dataset.featureFlags = JSON.stringify(features);
    }
  }

  window.PoolsideFlags = { apply };
})();

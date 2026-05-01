/* =============================================================================
 * PoolsideFlags — apply per-tenant feature flags + per-admin role scopes
 * =============================================================================
 * Usage: every admin page already calls tenant_admin_auth.me on init.
 * After it returns, call:
 *
 *   PoolsideFlags.apply(me.tenant.features || {}, me.user || {});
 *
 * Two-layer hiding:
 *   1. FEATURE flag (tenant-level): hide tabs the club doesn't use
 *   2. SCOPE check (per-admin role): hide tabs this user can't access
 *
 * Owner-role users see everything; everyone else sees only the tabs whose
 * scope is in their `scopes` array.
 * ============================================================================= */
(function () {
  'use strict';

  // Synchronous slug-based brand fallback. Runs the moment this script
  // loads so the user never sees "Poolside" in the header while waiting
  // for tenant_admin_auth.me to return. The async brand swap below
  // refines this with the real display_name + uploaded logo.
  try {
    var m = window.location.hostname.match(/^([a-z0-9][a-z0-9-]*)\.poolsideapp\.com$/i);
    var a = document.querySelector('header .logo');
    if (a && m && m[1] && m[1] !== 'www') {
      a.innerHTML = '<span class="logo-dot"></span> ' + (m[1].charAt(0).toUpperCase() + m[1].slice(1));
    } else if (a) {
      a.innerHTML = '<span class="logo-dot"></span>';
    }
  } catch (e) { /* defensive only */ }

  // Feature → nav selector (tenant-level toggles from settings.value.features)
  const FEATURE_NAV = {
    parties:       'a[href="/club/admin/parties.html"]',
    programs:      'a[href="/club/admin/programs.html"]',
    volunteer:     'a[href="/club/admin/volunteer.html"]',
    campaigns:     'a[href="/club/admin/campaigns.html"]',
    guest_passes:  'a[href="/club/admin/guest-passes.html"]',
  };

  // Scope → nav selector (per-admin role assignments).
  // Pages without a scope mapping (like the dashboard) are always visible.
  const SCOPE_NAV = {
    households:    'a[href="/club/admin/households.html"]',
    applications: ['a[href="/club/admin/applications.html"]'],
    payments:      'a[href="/club/admin/payments.html"]',
    // 'members' is the merged hub — visible if the user has EITHER
    // households OR applications scope. Handled separately below since
    // it needs OR-logic, not the per-scope hide loop.
    // (no entry here intentionally)
    events:        'a[href="/club/admin/events.html"]',
    programs:      'a[href="/club/admin/programs.html"]',
    parties:       'a[href="/club/admin/parties.html"]',
    announcements: 'a[href="/club/admin/announcements.html"]',
    campaigns:     'a[href="/club/admin/campaigns.html"]',
    volunteer:     'a[href="/club/admin/volunteer.html"]',
    passes:        'a[href="/club/admin/guest-passes.html"]',
    policies:      'a[href="/club/admin/policies.html"]',
    photos:        'a[href="/club/admin/photos.html"]',
    documents:     'a[href="/club/admin/documents.html"]',
    impact:        'a[href="/club/admin/impact.html"]',
    audit:         'a[href="/club/admin/audit.html"]',
    settings:      'a[href="/club/admin/settings.html"]',
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) {
    return String(s ?? '').replace(/["'<>&]/g, c => ({'"':'&quot;',"'":'&#39;','<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
  }

  function brandHeader(tenant) {
    if (!tenant) return;
    const a = document.querySelector('header .logo');
    if (!a) return;
    const name = tenant.display_name || 'Poolside';
    const logoUrl = tenant.branding && tenant.branding.logo_url;
    a.setAttribute('href', '/club/admin/');
    a.setAttribute('title', name);
    if (logoUrl) {
      a.innerHTML = `<img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(name)}" style="height:24px;width:24px;object-fit:cover;border-radius:6px"> ${escapeHtml(name)}`;
    } else {
      a.innerHTML = `<span class="logo-dot"></span> ${escapeHtml(name)}`;
    }
  }

  function apply(features, user, tenant) {
    features = features || {};
    if (tenant) brandHeader(tenant);

    // Layer 1: feature flags (hide entire features tenants didn't enable)
    for (const [flag, selector] of Object.entries(FEATURE_NAV)) {
      if (features[flag] === false) {
        document.querySelectorAll(selector).forEach(el => { el.style.display = 'none'; });
      }
    }
    if (features.keyfobs === false) {
      document.querySelectorAll('[data-feature="keyfobs"]').forEach(el => { el.style.display = 'none'; });
    }

    // Layer 2: per-admin scope. Owner sees everything (legacy + super users).
    if (user) {
      const isOwner = (user.role_template === 'owner') || user.is_super || user.impersonated;
      if (!isOwner) {
        const scopes = new Set(user.scopes || []);
        for (const [scope, selector] of Object.entries(SCOPE_NAV)) {
          if (!scopes.has(scope)) {
            const sels = Array.isArray(selector) ? selector : [selector];
            sels.forEach(s => document.querySelectorAll(s).forEach(el => { el.style.display = 'none'; }));
          }
        }
        // Members hub — visible if user has either households OR applications scope.
        if (!scopes.has('households') && !scopes.has('applications')) {
          document.querySelectorAll('a[href^="/club/admin/members.html"]').forEach(el => { el.style.display = 'none'; });
        }
        // Settings → Co-admins section is owner-only
        document.querySelectorAll('[data-owner-only]').forEach(el => { el.style.display = 'none'; });
      }
    }

    if (typeof features === 'object') {
      document.body.dataset.featureFlags = JSON.stringify(features);
    }
  }

  window.PoolsideFlags = { apply, brandHeader };
})();

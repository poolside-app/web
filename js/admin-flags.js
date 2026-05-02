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

  // Synchronous brand paint. Runs the moment this script loads so the
  // header never shows "Poolside" while waiting for tenant_admin_auth.me.
  //
  // We cache the tenant's display_name + logo_url in localStorage after
  // each successful me() call (see brandHeader below). On subsequent
  // loads we paint from cache → identical to what the API will return →
  // no two-stage flicker. First-ever visit falls back to a capitalized
  // slug. Empty fallback if even that fails.
  try {
    var a = document.querySelector('header .logo');
    if (a) {
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem('poolside_tenant_brand') || 'null'); } catch (_) { cached = null; }
      var slugMatch = window.location.hostname.match(/^([a-z0-9][a-z0-9-]*)\.poolsideapp\.com$/i);
      var slug = slugMatch && slugMatch[1] && slugMatch[1] !== 'www' ? slugMatch[1] : null;
      var name = (cached && cached.slug === slug && cached.display_name) ? cached.display_name
        : (slug ? (slug.charAt(0).toUpperCase() + slug.slice(1)) : '');
      var logoUrl = (cached && cached.slug === slug) ? cached.logo_url : null;
      function esc(s){return String(s||'').replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
      if (logoUrl) {
        a.innerHTML = '<img src="' + esc(logoUrl) + '" alt="" style="height:24px;width:24px;object-fit:cover;border-radius:6px"> ' + esc(name);
      } else {
        a.innerHTML = '<span class="logo-dot"></span> ' + esc(name);
      }
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
    // Cache for the next page load so the synchronous paint above matches
    // the API response → no flicker between cached and fresh values.
    try {
      const slugMatch = window.location.hostname.match(/^([a-z0-9][a-z0-9-]*)\.poolsideapp\.com$/i);
      const slug = slugMatch && slugMatch[1] && slugMatch[1] !== 'www' ? slugMatch[1] : null;
      localStorage.setItem('poolside_tenant_brand', JSON.stringify({
        slug, display_name: name, logo_url: logoUrl || null,
      }));
    } catch (_) { /* localStorage may be disabled; non-critical */ }
    // Only repaint if the rendered text actually differs from what's
    // already there. Otherwise the user sees an unnecessary flash.
    const currentText = a.textContent.trim();
    if (currentText === name && (!logoUrl || a.querySelector('img')?.getAttribute('src') === logoUrl)) {
      return;
    }
    if (logoUrl) {
      a.innerHTML = `<img src="${escapeAttr(logoUrl)}" alt="${escapeAttr(name)}" style="height:24px;width:24px;object-fit:cover;border-radius:6px"> ${escapeHtml(name)}`;
    } else {
      a.innerHTML = `<span class="logo-dot"></span> ${escapeHtml(name)}`;
    }
  }

  // ── Plan-usage ticker — shown in <header> of every admin page.
  // Caller passes the `usage` object from tenant_admin_auth.me() —
  // { count, cap, unlimited, at_cap, percent, plan, plan_label }.
  // Color states match the household-cap progression:
  //   < 80%  blue (informational)
  //   ≥ 80%  amber (upgrade soon)
  //   = 100% red (hard cap, '+ Add household' is blocked server-side)
  function paintUsageTicker(usage) {
    if (!usage) return;
    const header = document.querySelector('header');
    if (!header) return;
    if (header.querySelector('#usage-ticker')) return;  // already painted
    const pct = Math.max(0, Math.min(100, Number(usage.percent) || 0));
    const at = !!usage.at_cap;
    const near = pct >= 80 && !at;
    const color = at ? '#dc2626' : (near ? '#92400e' : '#0a3b5c');
    const bg    = at ? '#fee2e2' : (near ? '#fef3c7' : '#e6eef5');
    const fill  = at ? '#dc2626' : (near ? '#f59e0b' : '#0a3b5c');
    const capCopy = usage.unlimited ? '∞' : usage.cap;
    const remCopy = usage.unlimited
      ? 'unlimited'
      : (usage.remaining === 0 ? 'at cap' : `${usage.remaining} left`);
    const showUpgrade = !usage.unlimited && (pct >= 50 || at);
    const ticker = document.createElement('div');
    ticker.id = 'usage-ticker';
    ticker.style.cssText = `
      display:flex; align-items:center; gap:14px; padding:6px 14px;
      background:${bg}; color:${color}; font-size:12px; font-weight:600;
      border-bottom:1px solid #e5e7eb;
    `;
    ticker.innerHTML = `
      <span>${usage.count} / ${capCopy} households · ${escapeHtml(usage.plan_label)}</span>
      ${usage.unlimited ? '' : `
        <span style="flex:1; max-width:240px; height:6px; background:#e5e7eb; border-radius:999px; overflow:hidden">
          <span style="display:block; width:${pct}%; height:100%; background:${fill}"></span>
        </span>`}
      <span style="font-weight:500">${remCopy}</span>
      ${showUpgrade ? `<a href="/club/admin/billing.html" style="margin-left:auto; padding:3px 12px; border-radius:6px; background:${fill}; color:#fff; text-decoration:none; font-weight:700; font-size:11px; letter-spacing:.04em; text-transform:uppercase">${at ? 'Upgrade now' : 'Upgrade'}</a>` : ''}
    `;
    // Insert AFTER the header so it appears as a strip below it
    header.parentNode.insertBefore(ticker, header.nextSibling);
  }

  function apply(features, user, tenant, usage) {
    features = features || {};
    if (tenant) brandHeader(tenant);
    if (usage) paintUsageTicker(usage);

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
        // Members hub — visible if user has ANY members-section scope.
        const MEMBERS_SCOPES = ['households','applications','tiers','renewals','payments','programs','parties','volunteer','passes','documents'];
        const hasAnyMembers = MEMBERS_SCOPES.some(s => scopes.has(s));
        if (!hasAnyMembers) {
          document.querySelectorAll('a[href^="/club/admin/members.html"]').forEach(el => { el.style.display = 'none'; });
        }
        // Per-subtab scope hiding (renders by /js/members-subtabs.js)
        document.querySelectorAll('.members-subtabs a[data-scope]').forEach(el => {
          const need = el.dataset.scope;
          if (need && !scopes.has(need)) el.style.display = 'none';
        });
        // Settings → Co-admins section is owner-only
        document.querySelectorAll('[data-owner-only]').forEach(el => { el.style.display = 'none'; });
      }
    }

    if (typeof features === 'object') {
      document.body.dataset.featureFlags = JSON.stringify(features);
    }
  }

  window.PoolsideFlags = { apply, brandHeader, paintUsageTicker };
})();

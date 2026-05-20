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

  // ── Auto-renew admin tokens ───────────────────────────────────────────
  // tenant_admin_auth.me returns `renewed_token` whenever the current
  // token has been alive >7 days. We hook fetch globally so EVERY page
  // (not just the ones we update by hand) participates in the renewal.
  // The user effectively stays logged in as long as they use the app at
  // least once every 100 days — no per-page changes needed.
  try {
    const orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isMeCall = url.includes('/tenant_admin_auth');
      if (!isMeCall) return orig(input, init);
      return orig(input, init).then(async (res) => {
        try {
          // Clone so the original consumer can still read the body.
          const cloned = res.clone();
          const text = await cloned.text();
          if (text && text.length < 50000) {
            const data = JSON.parse(text);
            if (data && data.renewed_token && typeof data.renewed_token === 'string') {
              try { localStorage.setItem('poolside_tenant_token', data.renewed_token); }
              catch (_) { /* ignore */ }
            }
          }
        } catch (_) { /* response wasn't JSON or didn't contain token — ignore */ }
        return res;
      });
    };
  } catch (_) { /* fetch override is best-effort */ }

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
  // Feature → nav-selector map. Each entry declares the default state when
  // the flag is missing from settings (most features default ON since they
  // were the baseline before feature-flagging was added; newer opt-in
  // features default OFF). Without the explicit default, a missing key
  // would leave the nav visible — bug Doug hit 2026-05-20 with lifeguard
  // scheduling staying available after he unchecked it in the wizard.
  const FEATURE_NAV = {
    parties:               { selector: 'a[href="/club/admin/parties.html"]',    defaultOn: true  },
    programs:              { selector: 'a[href="/club/admin/programs.html"]',   defaultOn: true  },
    volunteer:             { selector: 'a[href="/club/admin/volunteer.html"]',  defaultOn: true  },
    campaigns:             { selector: 'a[href="/club/admin/campaigns.html"]',  defaultOn: true  },
    lifeguard_scheduling:  { selector: 'a[href="/club/admin/lifeguards.html"]', defaultOn: false },
    // guest_passes removed 2026-05-08
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
    // passes scope removed 2026-05-08
    policies:      'a[href="/club/admin/policies.html"]',
    photos:        'a[href="/club/admin/photos.html"]',
    impact:        'a[href="/club/admin/impact.html"]',
    audit:         'a[href="/club/admin/audit.html"]',
    settings:      'a[href="/club/admin/settings.html"]',
    meetings:      'a[href="/club/admin/board-meetings.html"]',
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

  // ── Setup-status banner — persistent "Club setup is X% complete" strip
  // shown on every admin page until all required items are checked off.
  // Hidden on the wizard + setup checklist itself (don't nag while the
  // user is actively fixing things). Hidden on login pages too.
  async function paintSetupBanner(token) {
    if (!token) return;
    const path = window.location.pathname || '';
    if (path.includes('/club/admin/setup.html')) return;
    if (path.includes('/club/wizard.html'))      return;
    if (path.includes('/login.html'))            return;
    if (document.getElementById('setup-banner')) return;  // already painted

    let data;
    try {
      const res = await fetch('https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/tenant_settings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'setup_status' }),
      });
      data = await res.json();
    } catch (_) { return; }
    if (!data || !data.ok || data.complete) return;

    const pct = Math.max(0, Math.min(100, Number(data.percent) || 0));
    const remaining = (data.total || 0) - (data.done || 0);
    const banner = document.createElement('div');
    banner.id = 'setup-banner';
    banner.style.cssText = `
      display:flex; align-items:center; gap:14px; padding:10px 18px;
      background:linear-gradient(90deg, #fef3c7, #fde68a);
      color:#78350f; font-size:13.5px; font-weight:600;
      border-bottom:1px solid #fbbf24;
    `;
    banner.innerHTML = `
      <span style="font-size:18px">⚠️</span>
      <div style="flex:1; min-width:0">
        <div>Club setup is <b>${pct}% complete</b> — ${remaining} item${remaining === 1 ? '' : 's'} left before members can apply and pay.</div>
        <div style="height:5px; background:rgba(120,53,15,.15); border-radius:999px; overflow:hidden; margin-top:6px; max-width:340px">
          <div style="width:${pct}%; height:100%; background:#92400e"></div>
        </div>
      </div>
      <a href="/club/admin/setup.html" style="padding:8px 16px; background:#0a3b5c; color:#fff; text-decoration:none; font-weight:700; font-size:12px; letter-spacing:.04em; text-transform:uppercase; border-radius:8px; white-space:nowrap; flex-shrink:0">Finish setup →</a>
    `;
    // Insert above usage-ticker if present, else after header.
    const header = document.querySelector('header');
    if (!header) return;
    const ticker = document.getElementById('usage-ticker');
    if (ticker) {
      ticker.parentNode.insertBefore(banner, ticker);
    } else {
      header.parentNode.insertBefore(banner, header.nextSibling);
    }
  }

  // Sticky banner shown on every admin page when Doug is impersonating a
  // tenant via the provider /admin tools. Clicking "Exit" wipes the local
  // token + returns to /admin/. Banner is intentionally bright + unmissable
  // so Doug never accidentally makes destructive changes thinking he's in
  // his own tools.
  function paintImpersonationBanner(user, tenant) {
    if (!user || !user.impersonated) return;
    if (document.getElementById('poolside-impersonation-banner')) return;
    const banner = document.createElement('div');
    banner.id = 'poolside-impersonation-banner';
    banner.style.cssText = 'background:#fef3c7;color:#78350f;padding:8px 22px;font-size:13px;text-align:center;border-bottom:1px solid #fde68a;display:flex;justify-content:center;align-items:center;gap:14px;position:sticky;top:0;z-index:10000';
    const safeName = String(tenant && tenant.display_name || 'this club').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    banner.innerHTML = '<span>🔑 You\'re impersonating <b>' + safeName + '</b>. Token expires in ≤1 hour.</span>'
      + ' <button type="button" id="poolside-exit-impersonation" style="padding:4px 12px;border-radius:6px;font:600 12px Inter,sans-serif;background:#78350f;color:#fff;border:0;cursor:pointer">Exit impersonation</button>';
    document.body.insertBefore(banner, document.body.firstChild);
    document.getElementById('poolside-exit-impersonation').addEventListener('click', function () {
      ['poolside_tenant_token','poolside_tenant_user','poolside_tenant_tenant'].forEach(function (k) {
        try { localStorage.removeItem(k); } catch (_) {}
      });
      // Provider always lives on the apex/www host, never on a tenant
      // subdomain — bounce there so Doug lands back in his tools.
      window.location.href = 'https://www.poolsideapp.com/admin/';
    });
  }

  function apply(features, user, tenant, usage) {
    features = features || {};
    if (tenant) brandHeader(tenant);
    if (usage) paintUsageTicker(usage);
    paintImpersonationBanner(user, tenant);
    // Fire-and-forget: banner paints async; don't block page render.
    try {
      const tok = localStorage.getItem('poolside_tenant_token');
      if (tok) paintSetupBanner(tok);
    } catch (_) { /* defensive */ }

    // Layer 1: feature flags (hide entire features tenants didn't enable)
    for (const [flag, { selector, defaultOn }] of Object.entries(FEATURE_NAV)) {
      const val = features[flag];
      // Hide when explicitly OFF, OR when the value is missing AND the
      // feature defaults to OFF (opt-in features like lifeguard_scheduling).
      const hide = val === false || (val === undefined && !defaultOn);
      if (hide) {
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
        const MEMBERS_SCOPES = ['households','applications','tiers','renewals','payments','programs','parties','volunteer','passes','meetings'];
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

  // Slide the admin session forward — if me() returned a freshly-issued
  // token (because the current one is more than 7 days old), persist it
  // here so the user effectively never has to log in again as long as
  // they keep using the app at least once every 100 days.
  function persistRenewedToken(tok) {
    if (!tok || typeof tok !== 'string') return;
    try { localStorage.setItem('poolside_tenant_token', tok); }
    catch (_) { /* storage may be disabled — ignore */ }
  }

  window.PoolsideFlags = { apply, brandHeader, paintUsageTicker, paintSetupBanner, paintImpersonationBanner, persistRenewedToken };

  // ── PoolsideAuth.meOrLogout ─────────────────────────────────────────────
  // Single robust "fetch /me and decide what to do" helper. Replaces the
  // aggressive `catch { logout(); }` pattern that was firing on every
  // network blip + every JSON parse failure + every non-200 response,
  // causing the "random logouts" Doug hit during the 2026-05-20 test.
  //
  // Logout fires ONLY when:
  //   • No token in localStorage (legit — there's nothing to do)
  //   • HTTP 401 (real auth failure — token bad or expired)
  //   • Error message explicitly mentions "auth" / "session" / "invalid"
  //
  // For network errors, 5xx, parse failures, or 200-with-unknown-error,
  // we throw a SessionError instead — the calling page decides whether to
  // show a retry button, render an inline error, or just continue.
  //
  // Usage on each admin page:
  //   const me = await PoolsideAuth.meOrLogout();
  //   if (!me) return;   // page already redirected to /login.html
  //   // use me.user, me.tenant, me.usage, me.renewed_token (already persisted)
  function poolsideLogout() {
    try {
      localStorage.removeItem('poolside_tenant_token');
      localStorage.removeItem('poolside_tenant_user');
      localStorage.removeItem('poolside_tenant_tenant');
    } catch (_) {}
    window.location.href = '/club/admin/login.html';
  }

  async function meOrLogout() {
    let tok;
    try { tok = localStorage.getItem('poolside_tenant_token'); } catch (_) { tok = null; }
    if (!tok) { poolsideLogout(); return null; }

    const SUPABASE_URL_LOCAL = 'https://sdewylbddkcvidwosgxo.supabase.co';
    const AUTH = `${SUPABASE_URL_LOCAL}/functions/v1/tenant_admin_auth`;

    let res;
    try {
      res = await fetch(AUTH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${tok}` },
        body: JSON.stringify({ action: 'me' }),
      });
    } catch (e) {
      // Pure network failure (offline, DNS, CORS preflight, etc.). Do NOT
      // log the user out — the token may be fine, the network just hiccupped.
      throw new Error('NETWORK');
    }

    if (res.status === 401) { poolsideLogout(); return null; }

    let data = null;
    try { data = await res.json(); } catch (_) { /* malformed response */ }
    if (!data) throw new Error('PARSE');

    if (data.ok === false) {
      const msg = String(data.error || '').toLowerCase();
      // Specific session-fatal errors mean the token is genuinely useless.
      if (/auth|session|invalid|expired|not found/.test(msg)) {
        poolsideLogout();
        return null;
      }
      throw new Error(data.error || 'me returned ok=false');
    }
    return data;
  }

  window.PoolsideAuth = { meOrLogout, logout: poolsideLogout };
})();

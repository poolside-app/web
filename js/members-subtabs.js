/* =============================================================================
 * members-subtabs.js — shared sub-tab strip for the Members section
 * =============================================================================
 * Renders into <div id="members-subtabs"></div>. Auto-detects which sub-tab
 * is active from the current URL. Each entry is a real <a> link so browser
 * back/forward and deep links Just Work — except Households↔Applications,
 * which both live on members.html and toggle via hash so the page doesn't
 * fully reload between those two.
 *
 * Visibility: each <a> has data-scope="<scope>". admin-flags.js hides the
 * tab if the signed-in admin lacks that scope (owners see everything).
 * ============================================================================= */
(function () {
  'use strict';

  // Sub-tab labels are intentionally distinct from the top-nav "Application"
  // (the apply-form EDITOR). The sub-tab below is the *queue* of incoming
  // applicants — separate concern. We renamed it from "Applications" to
  // "Pipeline" so the two surfaces don't read as duplicates in the chrome.
  // Tiers ALSO moved out of here — it lives under top-nav Application now.
  // Sub-tab labels are intentionally distinct from the top-nav "Application"
  // (the apply-form EDITOR). The sub-tab below is the *queue* of incoming
  // applicants — separate concern. We renamed it from "Applications" to
  // "Pipeline" so the two surfaces don't read as duplicates in the chrome.
  // Tiers ALSO moved out of here — it lives under top-nav Application now.
  const SUBTABS = [
    { key: 'households',   label: 'Households',   href: '/club/admin/members.html#households',   scope: 'households'   },
    { key: 'applications', label: 'Pipeline',     href: '/club/admin/members.html#applications', scope: 'applications' },
    { key: 'renewals',     label: 'Renewals',     href: '/club/admin/members.html#renewals',     scope: 'renewals'     },
    { key: 'payments',     label: 'Payments',     href: '/club/admin/payments.html',             scope: 'payments'     },
    { key: 'programs',     label: 'Programs',     href: '/club/admin/programs.html',             scope: 'programs'     },
    { key: 'parties',      label: 'Parties',      href: '/club/admin/parties.html',              scope: 'parties'      },
    { key: 'volunteer',    label: 'Volunteer',    href: '/club/admin/volunteer.html',            scope: 'volunteer'    },
    { key: 'passes',       label: 'Passes',       href: '/club/admin/guest-passes.html',         scope: 'passes'       },
    // Documents and Board minutes moved to Content sub-tabs (2026-05-08)
    // — they're governance content, not member operations.
    // Fundraiser donations — stripe-paid land here automatically; admin
    // records Venmo/cash/check by hand. Thermometer recomputes on every
    // insert/update/delete.
    { key: 'donations',    label: 'Donations',    href: '/club/admin/donations.html',            scope: 'payments'     },
    // Member-lifecycle email templates (renewals, plan installments, party
    // approve/deny). Application-lifecycle templates live on the
    // Application top-tab. emails.html honors ?audience=member to filter.
    { key: 'emails',       label: 'Emails',       href: '/club/admin/emails.html?audience=member', scope: 'settings'   },
  ];

  function detectActive() {
    const path = window.location.pathname;
    if (path.endsWith('/members.html')) {
      const hash = (window.location.hash || '').replace(/^#/, '');
      if (hash === 'applications') return 'applications';
      if (hash === 'tiers') return 'tiers';
      if (hash === 'renewals') return 'renewals';
      return 'households';
    }
    if (path.endsWith('/payments.html'))     return 'payments';
    if (path.endsWith('/programs.html'))     return 'programs';
    if (path.endsWith('/parties.html'))      return 'parties';
    if (path.endsWith('/volunteer.html'))    return 'volunteer';
    if (path.endsWith('/guest-passes.html')) return 'passes';
    if (path.endsWith('/documents.html'))    return 'documents';
    if (path.endsWith('/donations.html'))    return 'donations';
    if (path.endsWith('/emails.html'))       return 'emails';
    return null;
  }

  // Inject CSS once. Reuses the existing subtab styles from members.html so
  // pages don't have to define them.
  if (!document.getElementById('members-subtabs-css')) {
    const style = document.createElement('style');
    style.id = 'members-subtabs-css';
    style.textContent = `
      .members-subtabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--border); background: #fff; overflow-x: auto; }
      .members-subtabs a { padding: 14px 18px; font-size: 14px; font-weight: 600; color: var(--muted); border-bottom: 3px solid transparent; text-decoration: none; margin-bottom: -1px; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
      .members-subtabs a.on { color: var(--blue); border-bottom-color: var(--blue); }
      .members-subtabs a:hover { color: var(--blue); }
      .members-subtabs .badge { background: var(--sun); color: #fff; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; min-width: 20px; text-align: center; }
      .members-subtabs .badge.zero { background: var(--bg-2); color: var(--muted); }
    `;
    document.head.appendChild(style);
  }

  function render() {
    const container = document.getElementById('members-subtabs');
    if (!container) return;
    const active = detectActive();
    container.innerHTML = `<div class="members-subtabs">${SUBTABS.map(t => `
      <a href="${t.href}" class="${active === t.key ? 'on' : ''}" data-scope="${t.scope}" data-subtab="${t.key}">${t.label}${t.key === 'applications' ? ' <span class="badge zero" id="apps-badge">0</span>' : ''}</a>
    `).join('')}</div>`;
  }

  // Render synchronously — the <script> tag is placed right after
  // <div id="members-subtabs">, so the container element already exists
  // by the time this code runs. Waiting for DOMContentLoaded would cause
  // a visible layout shift as the strip appears late in the parse.
  render();
  // Re-render on hash change so members.html#households↔#applications updates the .on indicator
  window.addEventListener('hashchange', render);

  // Expose a way for pages to update the pending-applications badge.
  window.MembersSubtabs = {
    setPendingApps(n) {
      const b = document.getElementById('apps-badge');
      if (!b) return;
      b.textContent = n;
      b.classList.toggle('zero', !n);
    },
  };
})();

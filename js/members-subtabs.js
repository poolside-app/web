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

  const SUBTABS = [
    { key: 'households',   label: 'Households',   href: '/club/admin/members.html#households',   scope: 'households'   },
    { key: 'applications', label: 'Applications', href: '/club/admin/members.html#applications', scope: 'applications' },
    { key: 'payments',     label: 'Payments',     href: '/club/admin/payments.html',             scope: 'payments'     },
    { key: 'programs',     label: 'Programs',     href: '/club/admin/programs.html',             scope: 'programs'     },
    { key: 'parties',      label: 'Parties',      href: '/club/admin/parties.html',              scope: 'parties'      },
    { key: 'volunteer',    label: 'Volunteer',    href: '/club/admin/volunteer.html',            scope: 'volunteer'    },
    { key: 'passes',       label: 'Passes',       href: '/club/admin/guest-passes.html',         scope: 'passes'       },
    { key: 'documents',    label: 'Documents',    href: '/club/admin/documents.html',            scope: 'documents'    },
  ];

  function detectActive() {
    const path = window.location.pathname;
    if (path.endsWith('/members.html')) {
      const hash = (window.location.hash || '').replace(/^#/, '');
      return hash === 'applications' ? 'applications' : 'households';
    }
    if (path.endsWith('/payments.html'))     return 'payments';
    if (path.endsWith('/programs.html'))     return 'programs';
    if (path.endsWith('/parties.html'))      return 'parties';
    if (path.endsWith('/volunteer.html'))    return 'volunteer';
    if (path.endsWith('/guest-passes.html')) return 'passes';
    if (path.endsWith('/documents.html'))    return 'documents';
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render);
  } else {
    render();
  }
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

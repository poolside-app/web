/* =============================================================================
 * calendar-subtabs.js — sub-tab strip for the Calendar section
 * =============================================================================
 * Calendar groups time-bounded surfaces: events themselves, season state
 * (open/closed, freeze applications), and membership tiers (which dictate
 * what a season's renewals cost). Same pattern as members-subtabs and
 * content-subtabs.
 *
 * Visibility: each <a> has data-scope="<scope>". admin-flags.js hides the
 * tab if the signed-in admin lacks that scope (owners see everything).
 * ============================================================================= */
(function () {
  'use strict';

  const SUBTABS = [
    { key: 'events',     label: 'Events',      href: '/club/admin/events.html',                 scope: 'events'    },
    // Seasons (renewals) and Memberships (tiers) live in panels on
    // members.html — but conceptually they're calendar/season-bound, so
    // we show them under Calendar too. Cross-section sub-tabs.
    { key: 'seasons',    label: 'Seasons',     href: '/club/admin/members.html#renewals?nav=calendar', scope: 'renewals' },
    { key: 'memberships',label: 'Memberships', href: '/club/admin/members.html#tiers?nav=calendar',    scope: 'tiers'    },
  ];

  function detectActive() {
    const path = window.location.pathname;
    const hash = (window.location.hash || '').replace(/^#/, '').replace(/\?.*$/, '');
    const params = new URLSearchParams(window.location.search);
    if (path.endsWith('/events.html')) return 'events';
    if (path.endsWith('/members.html') && params.get('nav') === 'calendar') {
      if (hash === 'renewals') return 'seasons';
      if (hash === 'tiers')    return 'memberships';
    }
    return null;
  }

  if (!document.getElementById('calendar-subtabs-css')) {
    const style = document.createElement('style');
    style.id = 'calendar-subtabs-css';
    style.textContent = `
      .calendar-subtabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--border); background: #fff; overflow-x: auto; }
      .calendar-subtabs a { padding: 14px 18px; font-size: 14px; font-weight: 600; color: var(--muted); border-bottom: 3px solid transparent; text-decoration: none; margin-bottom: -1px; white-space: nowrap; }
      .calendar-subtabs a.on { color: var(--blue); border-bottom-color: var(--blue); }
      .calendar-subtabs a:hover { color: var(--blue); }
    `;
    document.head.appendChild(style);
  }

  function render() {
    const container = document.getElementById('calendar-subtabs');
    if (!container) return;
    const active = detectActive();
    container.innerHTML = `<div class="calendar-subtabs">${SUBTABS.map(t => `
      <a href="${t.href}" class="${active === t.key ? 'on' : ''}" data-scope="${t.scope}" data-subtab="${t.key}">${t.label}</a>
    `).join('')}</div>`;
  }

  render();
  window.addEventListener('hashchange', render);
})();

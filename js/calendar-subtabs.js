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

  // Calendar sub-tabs as of 2026-05-08 reshuffle: things HAPPENING at the
  // pool on a date. Members-related concepts (Tiers, Renewals) moved BACK
  // to Members where they belong — Calendar should not cross-link into
  // member surfaces; that was confusing and the cross-link itself was
  // broken. Programs, Parties, Volunteer, Passes are all date-bound
  // member-facing signups, so they live here.
  const SUBTABS = [
    { key: 'events',     label: 'Events',     href: '/club/admin/events.html',         scope: 'events'    },
    { key: 'programs',   label: 'Programs',   href: '/club/admin/programs.html',       scope: 'programs'  },
    { key: 'parties',    label: 'Parties',    href: '/club/admin/parties.html',        scope: 'parties'   },
    { key: 'volunteer',  label: 'Volunteer',  href: '/club/admin/volunteer.html',      scope: 'volunteer' },
    { key: 'passes',     label: 'Guest passes', href: '/club/admin/guest-passes.html', scope: 'passes'    },
  ];

  function detectActive() {
    const path = window.location.pathname;
    if (path.endsWith('/events.html'))       return 'events';
    if (path.endsWith('/programs.html'))     return 'programs';
    if (path.endsWith('/parties.html'))      return 'parties';
    if (path.endsWith('/volunteer.html'))    return 'volunteer';
    if (path.endsWith('/guest-passes.html')) return 'passes';
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

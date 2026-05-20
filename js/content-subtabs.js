/* =============================================================================
 * content-subtabs.js — sub-tab strip for the Content section
 * =============================================================================
 * Renders into <div id="content-subtabs"></div>. Same pattern as
 * /js/members-subtabs.js. Wraps the 5 publishing surfaces — announcements,
 * campaigns, sponsors, feedback, photos — under a single top-nav "Content"
 * tab so the chrome stays uncluttered.
 *
 * Visibility: each <a> has data-scope="<scope>". admin-flags.js hides the
 * tab if the signed-in admin lacks that scope (owners see everything).
 * ============================================================================= */
(function () {
  'use strict';

  // Order set by Doug 2026-05-21: announcements → campaigns → donations →
  // sponsors → photos → board minutes → feedback. Donations sits next to
  // campaigns since both are fundraising surfaces; feedback last since
  // it's a maintenance/listening surface, not a publishing one.
  const SUBTABS = [
    { key: 'announcements', label: 'Announcements', href: '/club/admin/announcements.html',  scope: 'announcements' },
    { key: 'campaigns',     label: 'Campaigns',     href: '/club/admin/campaigns.html',      scope: 'campaigns'     },
    { key: 'donations',     label: 'Donations',     href: '/club/admin/donations.html',      scope: 'payments'      },
    { key: 'sponsors',      label: 'Sponsors',      href: '/club/admin/sponsors.html',       scope: 'announcements' },
    { key: 'photos',        label: 'Photos',        href: '/club/admin/photos.html',         scope: 'photos'        },
    { key: 'meetings',      label: 'Board minutes', href: '/club/admin/board-meetings.html', scope: 'meetings'      },
    { key: 'feedback',      label: 'Feedback',      href: '/club/admin/feedback.html',       scope: 'announcements' },
  ];

  function detectActive() {
    const path = window.location.pathname;
    if (path.endsWith('/announcements.html'))   return 'announcements';
    if (path.endsWith('/campaigns.html'))       return 'campaigns';
    if (path.endsWith('/sponsors.html'))        return 'sponsors';
    if (path.endsWith('/feedback.html'))        return 'feedback';
    if (path.endsWith('/photos.html'))          return 'photos';
    if (path.endsWith('/donations.html'))       return 'donations';
    if (path.endsWith('/board-meetings.html'))  return 'meetings';
    return null;
  }

  if (!document.getElementById('content-subtabs-css')) {
    const style = document.createElement('style');
    style.id = 'content-subtabs-css';
    style.textContent = `
      .content-subtabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--border); background: #fff; overflow-x: auto; }
      .content-subtabs a { padding: 14px 18px; font-size: 14px; font-weight: 600; color: var(--muted); border-bottom: 3px solid transparent; text-decoration: none; margin-bottom: -1px; white-space: nowrap; }
      .content-subtabs a.on { color: var(--blue); border-bottom-color: var(--blue); }
      .content-subtabs a:hover { color: var(--blue); }
    `;
    document.head.appendChild(style);
  }

  function render() {
    const container = document.getElementById('content-subtabs');
    if (!container) return;
    const active = detectActive();
    container.innerHTML = `<div class="content-subtabs">${SUBTABS.map(t => `
      <a href="${t.href}" class="${active === t.key ? 'on' : ''}" data-scope="${t.scope}" data-subtab="${t.key}">${t.label}</a>
    `).join('')}</div>`;
  }

  render();
})();

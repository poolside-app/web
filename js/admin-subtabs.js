/* =============================================================================
 * admin-subtabs.js — every admin sub-tab strip, in one place
 * =============================================================================
 * Replaces members-subtabs.js / calendar-subtabs.js / content-subtabs.js /
 * insights-subtabs.js (2026-09-07). Those were four near-identical copies of
 * the same render + CSS-injection code, which is exactly how strips drift
 * apart: each reshuffle touched one file and the others quietly diverged.
 *
 * Every admin page now includes ONE container and ONE script:
 *     <div id="admin-subtabs"></div>
 *     <script src="/js/admin-subtabs.js"></script>
 * and this file works out which section the current page belongs to. That
 * also means scripts/rewrite_admin_nav.py no longer has to track which page
 * gets which strip — it injects the same block everywhere.
 *
 * Visibility: each <a> carries data-scope="<scope>". admin-flags.js hides it
 * when the signed-in admin lacks that scope (owners see everything).
 *
 * Strips are capped at 5 items. Past 5 the strip becomes a horizontal
 * scroller on a 390px phone, which hides tabs behind a gesture nobody
 * discovers — the same failure as having no link at all.
 * ============================================================================= */
(function () {
  'use strict';

  const SECTIONS = {
    // People. Renewals is a hash view on members.html that had no link at
    // all before today — reachable only by typing the URL.
    members: [
      { key: 'applications', label: 'Pipeline',   href: '/club/admin/members.html#applications', scope: 'applications' },
      { key: 'households',   label: 'Households', href: '/club/admin/members.html#households',   scope: 'households'   },
      { key: 'renewals',     label: 'Renewals',   href: '/club/admin/members.html#renewals',     scope: 'households'   },
      { key: 'policies',     label: 'Policies',   href: '/club/admin/policies.html',             scope: 'policies'     },
      { key: 'applyform',    label: 'Apply form', href: '/club/admin/application.html',          scope: 'applications' },
    ],
    // Money. Previously spread across four top tabs: dues under Members,
    // donations/sponsors/campaigns under Content, and billing nowhere at
    // all. A treasurer had to learn three tabs and one secret URL.
    money: [
      { key: 'payments',  label: 'Payments',  href: '/club/admin/payments.html',  scope: 'payments'      },
      { key: 'tiers',     label: 'Tiers',     href: '/club/admin/tiers.html',     scope: 'payments'      },
      { key: 'campaigns', label: 'Campaigns', href: '/club/admin/campaigns.html', scope: 'campaigns'     },
      { key: 'donations', label: 'Donations', href: '/club/admin/donations.html', scope: 'payments'      },
      { key: 'sponsors',  label: 'Sponsors',  href: '/club/admin/sponsors.html',  scope: 'announcements' },
    ],
    // Things that happen at the pool on a date. Lifeguards was a top-level
    // tab with the same weight as Settings, while Volunteer — the same job,
    // staffing the pool — sat down here.
    calendar: [
      { key: 'events',     label: 'Events',     href: '/club/admin/events.html',     scope: 'events'    },
      { key: 'programs',   label: 'Programs',   href: '/club/admin/programs.html',   scope: 'programs'  },
      { key: 'parties',    label: 'Parties',    href: '/club/admin/parties.html',    scope: 'parties'   },
      { key: 'volunteer',  label: 'Volunteer',  href: '/club/admin/volunteer.html',  scope: 'volunteer' },
      { key: 'lifeguards', label: 'Lifeguards', href: '/club/admin/lifeguards.html', scope: 'volunteer' },
    ],
    // Publishing + listening. No longer a junk drawer holding three money
    // surfaces alongside the announcements.
    content: [
      { key: 'announcements', label: 'Announcements', href: '/club/admin/announcements.html',  scope: 'announcements' },
      { key: 'photos',        label: 'Photos',        href: '/club/admin/photos.html',         scope: 'photos'        },
      { key: 'meetings',      label: 'Board minutes', href: '/club/admin/board-meetings.html', scope: 'meetings'      },
      { key: 'feedback',      label: 'Feedback',      href: '/club/admin/feedback.html',       scope: 'announcements' },
    ],
    insights: [
      { key: 'impact', label: 'Impact',    href: '/club/admin/impact.html', scope: 'impact'   },
      { key: 'audit',  label: 'Audit log', href: '/club/admin/audit.html',  scope: 'audit'    },
      { key: 'health', label: 'Status',    href: '/club/admin/health.html', scope: 'settings' },
    ],
    // Plan & billing lives here rather than under Money: it is the club's
    // account with Poolside, not the club's own books. It was previously
    // reachable ONLY through an "Upgrade" button that appears when a club
    // is near its household cap — so a club under its cap had no way to
    // reach its own billing page.
    settings: [
      { key: 'settings', label: 'Settings', href: '/club/admin/settings.html', scope: 'settings' },
      { key: 'admins',   label: 'Admins',   href: '/club/admin/admins.html',   scope: 'admins'   },
      { key: 'plan',     label: 'Plan',     href: '/club/admin/billing.html',  scope: 'settings' },
    ],
  };

  // Which section each page belongs to. Pages absent from this map render
  // no strip (dashboard, check-in, help, login, setup, change-password).
  const PAGE_SECTION = {
    'members.html': 'members', 'policies.html': 'members', 'application.html': 'members',
    'import.html': 'members', 'migrate.html': 'members', 'emails.html': 'members',
    'payments.html': 'money', 'tiers.html': 'money', 'campaigns.html': 'money',
    'donations.html': 'money', 'sponsors.html': 'money',
    'events.html': 'calendar', 'programs.html': 'calendar', 'parties.html': 'calendar',
    'volunteer.html': 'calendar', 'lifeguards.html': 'calendar', 'my-shifts.html': 'calendar',
    'announcements.html': 'content', 'photos.html': 'content',
    'board-meetings.html': 'content', 'feedback.html': 'content',
    'impact.html': 'insights', 'audit.html': 'insights', 'health.html': 'insights',
    'settings.html': 'settings', 'admins.html': 'settings', 'billing.html': 'settings',
  };

  const file = (window.location.pathname.split('/').pop() || 'index.html');
  const section = PAGE_SECTION[file];
  if (!section) return;
  const items = SECTIONS[section];

  // members.html hosts three views behind #hashes, so the active item there
  // depends on the hash rather than the filename.
  function activeKey() {
    if (file === 'members.html') {
      const h = (window.location.hash || '').replace(/^#/, '');
      return (h === 'applications' || h === 'renewals') ? h : 'households';
    }
    const hit = items.find(t => t.href.split('#')[0].endsWith('/' + file));
    return hit ? hit.key : null;
  }

  if (!document.getElementById('admin-subtabs-css')) {
    const style = document.createElement('style');
    style.id = 'admin-subtabs-css';
    style.textContent = `
      .admin-subtabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--border); background: #fff; overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .admin-subtabs a { padding: 14px 18px; font-size: 14px; font-weight: 600; color: var(--muted); border-bottom: 3px solid transparent; text-decoration: none; margin-bottom: -1px; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; font-family: inherit; }
      .admin-subtabs a.on { color: var(--blue); border-bottom-color: var(--blue); }
      .admin-subtabs a:hover { color: var(--blue); }
      .admin-subtabs .badge { background: var(--sun); color: #fff; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; min-width: 20px; text-align: center; }
      .admin-subtabs .badge.zero { background: var(--bg-2); color: var(--muted); }

      /* A 5-item strip cannot fit 390px: Members needs ~207px more than it
         has. The page itself does not overflow — the strip scrolls — but a
         silent scroller is barely better than no link, because nothing tells
         you two tabs exist off the right edge. Tighten the padding on narrow
         screens and fade whichever edge has more behind it. */
      @media (max-width: 560px) {
        .admin-subtabs { padding: 0 12px; }
        .admin-subtabs a { padding: 13px 11px; font-size: 13.5px; }
      }
      .admin-subtabs-wrap { position: relative; }
      .admin-subtabs-wrap::before,
      .admin-subtabs-wrap::after {
        content: ''; position: absolute; top: 0; bottom: 1px; width: 26px;
        pointer-events: none; opacity: 0; transition: opacity .15s; z-index: 1;
      }
      .admin-subtabs-wrap::before { left: 0;  background: linear-gradient(to right, #fff, rgba(255,255,255,0)); }
      .admin-subtabs-wrap::after  { right: 0; background: linear-gradient(to left,  #fff, rgba(255,255,255,0)); }
      .admin-subtabs-wrap.more-left::before  { opacity: 1; }
      .admin-subtabs-wrap.more-right::after  { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  function render() {
    const el = document.getElementById('admin-subtabs');
    if (!el) return;
    const active = activeKey();
    el.innerHTML = `<div class="admin-subtabs-wrap"><div class="admin-subtabs">${items.map(t => `
      <a href="${t.href}" class="${active === t.key ? 'on' : ''}" data-scope="${t.scope}" data-subtab="${t.key}">${t.label}${t.key === 'applications' ? ' <span class="badge zero" id="apps-badge">0</span>' : ''}</a>
    `).join('')}</div></div>`;

    // Show the edge fades only when there is genuinely more to see, and
    // keep the active tab in view — landing on Money > Sponsors with the
    // strip scrolled to the left would look like Sponsors isn't there.
    const wrap = el.querySelector('.admin-subtabs-wrap');
    const strip = el.querySelector('.admin-subtabs');
    const sync = () => {
      const max = strip.scrollWidth - strip.clientWidth;
      wrap.classList.toggle('more-left', strip.scrollLeft > 2);
      wrap.classList.toggle('more-right', strip.scrollLeft < max - 2);
    };
    strip.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    const on = strip.querySelector('a.on');
    if (on && strip.scrollWidth > strip.clientWidth) {
      on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    sync();
  }

  // Rendered synchronously: the <script> sits immediately after its
  // container, so the element exists. Waiting for DOMContentLoaded would
  // make the strip appear late and shift the page.
  render();
  window.addEventListener('hashchange', render);

  // Preserved from members-subtabs.js — members.html calls this to show the
  // pending-application count on the Pipeline tab.
  window.MembersSubtabs = {
    setPendingApps(n) {
      const b = document.getElementById('apps-badge');
      if (!b) return;
      b.textContent = n;
      b.classList.toggle('zero', !n);
    },
  };
})();

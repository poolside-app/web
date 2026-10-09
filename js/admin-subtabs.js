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
    ],
    // Money. Previously spread across four top tabs: dues under Members,
    // donations/sponsors/campaigns under Content, and billing nowhere at
    // all. A treasurer had to learn three tabs and one secret URL.
    money: [
      { key: 'payments',  label: 'Payments',  href: '/club/admin/payments.html',  scope: 'payments'      },
      { key: 'upcoming',  label: 'Upcoming',  href: '/club/admin/upcoming.html',  scope: 'payments'      },  // PLAN.md S: approve plan payments
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
      { key: 'meetings',      label: 'Board minutes', href: '/club/admin/board-meetings.html', scope: ''              },  // every board member
      { key: 'memberhelp',    label: 'Member help',   href: '/club/admin/member-help.html',    scope: ''              },  // every board member
    ],
    insights: [
      { key: 'audit',  label: 'Audit log', href: '/club/admin/audit.html',  scope: 'audit'    },
    ],
    // Plan & billing lives here rather than under Money: it is the club's
    // account with Poolside, not the club's own books. It was previously
    // reachable ONLY through an "Upgrade" button that appears when a club
    // is near its household cap — so a club under its cap had no way to
    // reach its own billing page.
    settings: [
      { key: 'settings', label: 'Settings', href: '/club/admin/settings.html', scope: 'settings' },
      { key: 'board',    label: 'Board',    href: '/club/admin/board.html',    scope: ''         },  // every board member reads it; the president edits
      { key: 'keyfobs',  label: 'Keyfobs',  href: '/club/admin/keyfobs.html',  scope: 'keyfobs', feature: 'keyfobs' },
      { key: 'emails',   label: 'Emails',   href: '/club/admin/emails.html',   scope: 'announcements' },  // PLAN.md T: moved from Members
      { key: 'plan',     label: 'Plan',     href: '/club/admin/billing.html',  scope: 'settings' },
    ],
  };

  // Which section each page belongs to. Pages absent from this map render
  // no strip (dashboard, check-in, help, login, setup, change-password).
  const PAGE_SECTION = {
    'members.html': 'members', 'policies.html': 'members',
    'import.html': 'members', 'migrate.html': 'members',
    'payments.html': 'money',
    'donations.html': 'money', 'sponsors.html': 'money', 'upcoming.html': 'money',
    'events.html': 'calendar', 'programs.html': 'calendar', 'parties.html': 'calendar',
    'volunteer.html': 'calendar', 'lifeguards.html': 'calendar', 'my-shifts.html': 'calendar',
    'announcements.html': 'content', 'photos.html': 'content',
    'board-meetings.html': 'content', 'member-help.html': 'content',
    'audit.html': 'insights',
    'settings.html': 'settings', 'board.html': 'settings', 'keyfobs.html': 'settings', 'emails.html': 'settings', 'billing.html': 'settings',
  };

  // admin-flags.js puts the waiting-task numbers on these tabs (PLAN.md R1).
  window.AdminSections = { SECTIONS, PAGE_SECTION };

  // ── The bottom bar on phones (PLAN.md W3) ──────────────────────────────
  // Doug, 10/9: the member app's bottom bar on every board page. Home, the
  // sections this person can use (from the screens the President ticked
  // for their position), and More with the rest, help, member view and sign
  // out. Computers keep the top tabs, which now hide the same sections and
  // open each one on a screen the person can use (a Facilities Director's
  // Settings opens Keyfobs; it used to be hidden from them altogether).
  // admin-flags.js calls AdminNav.render(user, features) once it knows who
  // is signed in; until then the last visit's answer is used.
  const FEATURE_OF = { programs: ['programs', true], parties: ['parties', true], volunteer: ['volunteer', true],
    lifeguards: ['lifeguard_scheduling', false], keyfobs: ['keyfobs', true] };
  const SECTION_LOOK = {
    members: ['👪', 'Members', '/club/admin/members.html'], money: ['💵', 'Money', '/club/admin/payments.html'],
    calendar: ['📅', 'Calendar', '/club/admin/events.html'], content: ['📰', 'Content', '/club/admin/announcements.html'],
    settings: ['⚙️', 'Settings', '/club/admin/settings.html'], insights: ['📊', 'Insights', '/club/admin/audit.html'],
  };
  const BAR_ORDER = ['members', 'money', 'calendar', 'content', 'settings', 'insights'];
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function ownerish(user) {
    return !user || user.role_template === 'owner' || !!user.is_super || !!user.impersonated || (user.roles || []).includes('owner');
  }
  function itemOn(item, user, features) {
    const f = FEATURE_OF[item.key];
    if (f) { const v = (features || {})[f[0]]; if (f[1] ? v === false : !v) return false; }
    return ownerish(user) || !item.scope || (user.scopes || []).includes(item.scope);
  }
  /** The sections this person can use, each opening on a screen they can use. */
  function sectionsFor(user, features) {
    return BAR_ORDER.map(key => {
      const items = SECTIONS[key].filter(i => itemOn(i, user, features));
      if (!items.length) return null;
      const [icon, label, canonical] = SECTION_LOOK[key];
      const canon = items.find(i => i.href.split('#')[0] === canonical);
      const mine = items.find(i => i.scope);
      return { key, icon, label, href: canon ? canonical : (mine || items[0]).href, items };
    }).filter(Boolean);
  }
  /** Home, the first three sections, More. */
  function barFor(user, features) {
    const secs = sectionsFor(user, features);
    return [{ key: 'home', icon: '🏠', label: 'Home', href: '/club/admin/' }, ...secs.slice(0, 3),
      { key: 'more', icon: '☰', label: 'More', href: '#more', rest: secs.slice(3) }];
  }

  let navUser = null, navFeatures = {}, navCounts = null;
  function pageSection() {
    const f = (window.location.pathname.split('/').pop() || 'index.html');
    return f === 'index.html' || f === '' ? 'home' : (PAGE_SECTION[f] || null);
  }
  function fixTopTabs(secs) {
    const byKey = Object.fromEntries(secs.map(x => [x.key, x]));
    document.querySelectorAll('nav.tabs a').forEach(a => {
      if (!a.dataset.section) {
        const href = (a.getAttribute('href') || '').split('#')[0];
        const key = Object.keys(SECTION_LOOK).find(k => SECTION_LOOK[k][2] === href);
        if (!key) return;
        a.dataset.section = key;
      }
      const sec = byKey[a.dataset.section];
      a.style.display = sec ? '' : 'none';
      if (sec) a.setAttribute('href', sec.href);
    });
  }
  function paintBarBadges() {
    const bar = document.getElementById('btabs');
    if (!bar || !navCounts) return;
    const top = navCounts.top || {};
    bar.querySelectorAll('a[data-btab]').forEach(a => {
      const k = a.dataset.btab;
      const n = k === 'home' ? (navCounts.total || 0)
        : k === 'more' ? (a.dataset.restKeys || '').split(',').filter(Boolean).reduce((m, r) => m + (top[r] || 0), 0)
        : (top[k] || 0);
      const b = a.querySelector('.nb');
      b.textContent = String(n);
      b.hidden = !n;
    });
  }
  function closeMore() { document.getElementById('btabs-more')?.remove(); }
  function openMore(rest) {
    closeMore();
    const signout = document.getElementById('signout');
    const memberView = navUser && navUser.linked_member_id;
    const row = (href, icon, label, sub, attrs) => `<a href="${esc(href)}"${attrs || ''}><span class="i">${icon}</span><span>${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span></a>`;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="btabs-more">
        <div class="btabs-scrim"></div>
        <div class="btabs-sheet" role="dialog" aria-label="More">
          <div class="grab"></div>
          ${rest.map(x => row(x.href, x.icon, x.label, x.items.map(i => i.label).join(', '))).join('')}
          ${row('/club/admin/help.html', '❓', 'Help and guides')}
          ${memberView ? row('/m/', '👤', 'Member view') : ''}
          ${row('#signout', '↪️', 'Sign out', '', ' data-signout="1"')}
        </div>
      </div>`);
    const wrap = document.getElementById('btabs-more');
    wrap.querySelector('.btabs-scrim').addEventListener('click', closeMore);
    wrap.querySelector('[data-signout]').addEventListener('click', e => {
      e.preventDefault();
      closeMore();
      if (signout) { signout.click(); return; }
      ['poolside_tenant_token', 'poolside_tenant_user', 'poolside_tenant_tenant'].forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
      window.location.href = '/club/admin/login.html';
    });
  }
  function injectBarCss() {
    if (document.getElementById('admin-btabs-css')) return;
    const style = document.createElement('style');
    style.id = 'admin-btabs-css';
    style.textContent = `
      .btabs { display: none; }
      @media (max-width: 767px) {
        body.has-btabs nav.tabs { display: none !important; }
        body.has-btabs header .who { display: none !important; }
        .btabs { display: flex; position: fixed; left: 0; right: 0; bottom: 0; z-index: 70; background: #fff; border-top: 1px solid var(--border, #e5e7eb); padding: 4px 4px calc(6px + env(safe-area-inset-bottom)); box-shadow: 0 -4px 16px rgba(10,59,92,.06); transform: translateZ(0); }
        .btabs a { flex: 1; max-width: 200px; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 2px; font: 600 11px 'Inter', system-ui, sans-serif; color: var(--muted, #5d6b81); border-radius: 10px; text-decoration: none; position: relative; }
        .btabs a .i { font-size: 21px; line-height: 1.1; }
        .btabs a.on { color: var(--blue, #0a3b5c); background: var(--blue-l, #e6eef5); }
        .btabs a .nb { position: absolute; top: 1px; left: 50%; margin-left: 7px; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--sun, #f59e0b); color: #fff; font: 700 10.5px/18px 'Inter', system-ui, sans-serif; text-align: center; }
        body.has-btabs { padding-bottom: calc(76px + env(safe-area-inset-bottom)) !important; }
        body.has-btabs #poolside-help-fab { display: none !important; }
        body.has-btabs .toast { bottom: calc(86px + env(safe-area-inset-bottom)) !important; }
        body.has-btabs #bar { bottom: calc(62px + env(safe-area-inset-bottom)) !important; }
        #btabs-more .btabs-scrim { position: fixed; inset: 0; background: rgba(15,23,42,.42); z-index: 80; }
        #btabs-more .btabs-sheet { position: fixed; left: 0; right: 0; bottom: 0; z-index: 81; background: #fff; border-radius: 20px 20px 0 0; padding: 10px 18px calc(22px + env(safe-area-inset-bottom)); box-shadow: 0 -10px 30px rgba(0,0,0,.15); max-height: 80vh; overflow-y: auto; }
        #btabs-more .grab { width: 40px; height: 5px; border-radius: 9px; background: #d1d5db; margin: 0 auto 8px; }
        #btabs-more a { display: flex; align-items: center; gap: 14px; padding: 13px 4px; border-top: 1px solid var(--border, #e5e7eb); color: var(--text, #0f172a); text-decoration: none; font: 600 15px 'Inter', system-ui, sans-serif; }
        #btabs-more .grab + a { border-top: 0; }
        #btabs-more a .i { font-size: 21px; width: 26px; text-align: center; }
        #btabs-more a small { display: block; font: 500 12.5px 'Inter', system-ui, sans-serif; color: var(--muted, #5d6b81); }
      }`;
    document.head.appendChild(style);
  }
  function renderNav(user, features) {
    navUser = user || null;
    navFeatures = features || {};
    const secs = sectionsFor(navUser, navFeatures);
    fixTopTabs(secs);
    if (!document.body) return;
    injectBarCss();
    const bar = barFor(navUser, navFeatures);
    const here = pageSection();
    const inBar = bar.some(b => b.key === here);
    const more = bar[bar.length - 1];
    document.getElementById('btabs')?.remove();
    document.body.insertAdjacentHTML('beforeend', `
      <nav class="btabs" id="btabs" aria-label="Board sections">
        ${bar.map(b => `<a href="${esc(b.href)}" data-btab="${b.key}"${b.key === 'more' ? ` data-rest-keys="${esc(more.rest.map(r => r.key).join(','))}"` : ''} class="${b.key === here || (b.key === 'more' && here && !inBar) ? 'on' : ''}"><span class="i">${b.icon}</span>${esc(b.label)}<span class="nb" hidden></span></a>`).join('')}
      </nav>`);
    document.body.classList.add('has-btabs');
    document.querySelector('#btabs [data-btab="more"]').addEventListener('click', e => { e.preventDefault(); openMore(more.rest); });
    paintBarBadges();
  }
  // The numbers come from admin-flags.js (paintFromTasks).
  document.addEventListener('poolside:badges', e => { navCounts = e.detail || null; paintBarBadges(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMore(); });
  window.AdminNav = { sectionsFor, barFor, render: renderNav };
  // Draw straight away from the last visit, so the bar doesn't pop in late.
  try {
    const u = JSON.parse(localStorage.getItem('poolside_tenant_user') || 'null');
    const f = JSON.parse(localStorage.getItem('poolside_tenant_features') || 'null');
    if (u) {
      const draw = () => renderNav(u, f || {});
      if (document.body) draw(); else document.addEventListener('DOMContentLoaded', draw, { once: true });
    }
  } catch (_) { /* no saved answer yet: admin-flags draws it */ }

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
      <a href="${t.href}" class="${active === t.key ? 'on' : ''}" data-scope="${t.scope}"${t.feature ? ` data-feature="${t.feature}"` : ''} data-subtab="${t.key}">${t.label}${t.key === 'applications' ? ' <span class="badge zero" id="apps-badge">0</span>' : ''}</a>
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
    // Fraunces/Inter land after first paint and change the strip's width,
    // so a sync that only runs now can leave a fade showing on a strip
    // with nothing hidden behind it (Calendar did exactly that at 390px).
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync).catch(() => {});
    // admin-flags.js hides tabs asynchronously once it has the tenant's
    // feature flags and the admin's scopes — it sets style.display on the
    // <a> elements. Calendar showed a fade over nothing because Lifeguards
    // (flag defaults off) was removed after the first sync. Watch for it.
    if (window.MutationObserver) {
      new MutationObserver(sync).observe(strip, {
        attributes: true, subtree: true, attributeFilter: ['style', 'class'],
      });
    }
    const on = strip.querySelector('a.on');
    if (on && strip.scrollWidth > strip.clientWidth) {
      on.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
    sync();
    // Re-rendered on a hash change: put the waiting counts back.
    if (window.PoolsideNav && window.PoolsideNav.paintSubBadges) window.PoolsideNav.paintSubBadges();
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

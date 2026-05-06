/* =============================================================================
 * insights-subtabs.js — sub-tab strip for the Insights section
 * =============================================================================
 * Renders into <div id="insights-subtabs"></div>. Wraps Impact (time-saved
 * metrics), Status (admin health diagnostic), and Audit (per-tenant audit
 * log) under a single top-nav "Insights" tab. Less-used surfaces; keeps
 * the main chrome uncluttered.
 * ============================================================================= */
(function () {
  'use strict';

  const SUBTABS = [
    { key: 'impact', label: 'Impact', href: '/club/admin/impact.html', scope: 'impact' },
    { key: 'audit',  label: 'Audit log', href: '/club/admin/audit.html', scope: 'audit' },
    { key: 'health', label: 'Status',  href: '/club/admin/health.html', scope: 'settings' },
  ];

  function detectActive() {
    const path = window.location.pathname;
    if (path.endsWith('/impact.html')) return 'impact';
    if (path.endsWith('/audit.html'))  return 'audit';
    if (path.endsWith('/health.html')) return 'health';
    return null;
  }

  if (!document.getElementById('insights-subtabs-css')) {
    const style = document.createElement('style');
    style.id = 'insights-subtabs-css';
    style.textContent = `
      .insights-subtabs { display: flex; gap: 4px; padding: 0 22px; border-bottom: 1px solid var(--border); background: #fff; overflow-x: auto; }
      .insights-subtabs a { padding: 14px 18px; font-size: 14px; font-weight: 600; color: var(--muted); border-bottom: 3px solid transparent; text-decoration: none; margin-bottom: -1px; white-space: nowrap; }
      .insights-subtabs a.on { color: var(--blue); border-bottom-color: var(--blue); }
      .insights-subtabs a:hover { color: var(--blue); }
    `;
    document.head.appendChild(style);
  }

  function render() {
    const container = document.getElementById('insights-subtabs');
    if (!container) return;
    const active = detectActive();
    container.innerHTML = `<div class="insights-subtabs">${SUBTABS.map(t => `
      <a href="${t.href}" class="${active === t.key ? 'on' : ''}" data-scope="${t.scope}" data-subtab="${t.key}">${t.label}</a>
    `).join('')}</div>`;
  }

  render();
})();

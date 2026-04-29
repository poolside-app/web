/* =============================================================================
 * PoolsideCalendar — shared month-grid widget
 * =============================================================================
 * Read-only month grid used on /club/index.html (public landing) and /m/
 * (member dashboard). Self-contained: pages just include calendar.css +
 * calendar.js, then call:
 *
 *   PoolsideCalendar.render({
 *     rootEl,           // DOM element to render into
 *     events,           // [{ id, title, kind, starts_at, ends_at, all_day, location, body }]
 *     openHoursLabel,   // optional "10A–8P" string shown in each non-other-month cell
 *   });
 *
 * The widget owns its own modal — clicks on an event chip open a detail
 * popup with kind, time, location, and body.
 * ============================================================================= */
(function () {
  'use strict';

  const KIND_ICON = {
    event: '📅', party: '🎉', swim_meet: '🏊‍♀️', social: '🥳',
    closure: '🚫', holiday: '🎆', lesson: '🏫', meeting: '📋',
  };
  const KIND_LABEL = {
    event: 'Event', party: 'Party', swim_meet: 'Swim meet', social: 'Social',
    closure: 'Closure', holiday: 'Holiday', lesson: 'Lesson', meeting: 'Meeting',
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }
  const pad = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const fmtMonth = (d) => d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtLong = (d) => d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

  function fmtTimeRange(ev) {
    const start = new Date(ev.starts_at);
    if (ev.all_day) return 'All day';
    if (!ev.ends_at) return fmtTime(start);
    const end = new Date(ev.ends_at);
    if (start.toDateString() === end.toDateString()) return `${fmtTime(start)} – ${fmtTime(end)}`;
    return `${start.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} → ${end.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`;
  }

  // Single shared modal across all calendar instances on the page
  let _modal = null;
  function ensureModal() {
    if (_modal) return _modal;
    const m = document.createElement('div');
    m.className = 'pcal-modal';
    m.innerHTML = `
      <div class="pcal-modal-card">
        <button class="pcal-modal-close" aria-label="Close">×</button>
        <div class="pcal-modal-kind"></div>
        <h3 class="pcal-modal-title"></h3>
        <div class="pcal-modal-time"></div>
        <div class="pcal-modal-loc"></div>
        <div class="pcal-modal-body"></div>
      </div>
    `;
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.remove('open'); });
    m.querySelector('.pcal-modal-card').addEventListener('click', (e) => e.stopPropagation());
    m.querySelector('.pcal-modal-close').addEventListener('click', () => m.classList.remove('open'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && m.classList.contains('open')) m.classList.remove('open');
    });
    document.body.appendChild(m);
    _modal = m;
    return m;
  }

  function showEvent(ev) {
    const m = ensureModal();
    m.querySelector('.pcal-modal-kind').textContent =
      `${KIND_ICON[ev.kind] || '📅'} ${KIND_LABEL[ev.kind] || ev.kind || 'Event'}`;
    m.querySelector('.pcal-modal-title').textContent = ev.title || '';
    m.querySelector('.pcal-modal-time').textContent =
      `${fmtLong(new Date(ev.starts_at))} · ${fmtTimeRange(ev)}`;
    const loc = m.querySelector('.pcal-modal-loc');
    if (ev.location) { loc.textContent = `📍 ${ev.location}`; loc.style.display = 'block'; }
    else { loc.style.display = 'none'; }
    const body = m.querySelector('.pcal-modal-body');
    if (ev.body) { body.textContent = ev.body; body.style.display = 'block'; }
    else { body.style.display = 'none'; }
    m.classList.add('open');
  }

  function render({ rootEl, events, openHoursLabel }) {
    if (!rootEl) return;

    const cursor = (() => { const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d; })();
    const today  = (() => { const d = new Date(); d.setHours(0,0,0,0); return d; })();

    const byDay = new Map();
    for (const ev of (events || [])) {
      const k = dateKey(new Date(ev.starts_at));
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(ev);
    }
    // Sort each day's events by start time so the chip order is deterministic
    for (const arr of byDay.values()) arr.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

    const dows = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    function draw() {
      const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const lastDay  = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const start = new Date(firstDay); start.setDate(start.getDate() - start.getDay());
      const end   = new Date(lastDay);  end.setDate(end.getDate() + (6 - end.getDay()));

      let html = `
        <div class="pcal-head">
          <h3 class="pcal-month">${escapeHtml(fmtMonth(cursor))}</h3>
          <div class="pcal-nav">
            <button class="pcal-nav-btn" data-action="prev"  aria-label="Previous month">‹</button>
            <button class="pcal-nav-btn pcal-today" data-action="today">Today</button>
            <button class="pcal-nav-btn" data-action="next"  aria-label="Next month">›</button>
          </div>
        </div>
        <div class="pcal-grid">${dows.map(d => `<div class="pcal-dow">${d}</div>`).join('')}`;

      const cur = new Date(start);
      while (cur <= end) {
        const k = dateKey(cur);
        const otherMonth = cur.getMonth() !== cursor.getMonth();
        const isToday    = cur.getTime() === today.getTime();
        const dayEvents  = byDay.get(k) || [];
        const visible    = dayEvents.slice(0, 3);
        const overflow   = dayEvents.length - visible.length;
        const hours = (!otherMonth && openHoursLabel)
          ? `<div class="pcal-hours">${escapeHtml(openHoursLabel)}</div>` : '';
        html += `
          <div class="pcal-day ${otherMonth ? 'pcal-other' : ''} ${isToday ? 'pcal-today-cell' : ''}">
            <div class="pcal-num">${cur.getDate()}</div>
            ${hours}
            ${visible.map(ev => `
              <div class="pcal-chip pcal-${escapeHtml(ev.kind)}" data-k="${k}" data-id="${escapeHtml(ev.id)}" title="${escapeHtml(ev.title)}">
                ${escapeHtml(KIND_ICON[ev.kind] || '')} ${escapeHtml(ev.title)}
              </div>
            `).join('')}
            ${overflow > 0 ? `<div class="pcal-more" data-k="${k}">+ ${overflow} more</div>` : ''}
          </div>`;
        cur.setDate(cur.getDate() + 1);
      }
      html += `</div>`;
      rootEl.innerHTML = html;

      rootEl.querySelectorAll('.pcal-nav-btn').forEach(b => {
        b.addEventListener('click', () => {
          const a = b.dataset.action;
          if (a === 'prev') cursor.setMonth(cursor.getMonth() - 1);
          else if (a === 'next') cursor.setMonth(cursor.getMonth() + 1);
          else if (a === 'today') {
            cursor.setFullYear(today.getFullYear());
            cursor.setMonth(today.getMonth());
            cursor.setDate(1);
          }
          draw();
        });
      });

      rootEl.querySelectorAll('.pcal-chip').forEach(c => {
        c.addEventListener('click', () => {
          const evs = byDay.get(c.dataset.k) || [];
          const ev = evs.find(e => String(e.id) === c.dataset.id);
          if (ev) showEvent(ev);
        });
      });

      // "+ N more" → show first overflow event for now (could expand to a
      // day-list popover later)
      rootEl.querySelectorAll('.pcal-more').forEach(c => {
        c.addEventListener('click', () => {
          const evs = byDay.get(c.dataset.k) || [];
          if (evs.length) showEvent(evs[3]);
        });
      });
    }
    draw();
  }

  window.PoolsideCalendar = { render };
})();

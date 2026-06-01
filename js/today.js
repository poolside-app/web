// =============================================================================
// today.js — shared "Today at the pool" block for the public + member homepages
// =============================================================================
// One engine so both pages decipher events vs hours identically:
//   • HOURS come from settings (pool.opens_at/closes_at) — never a calendar row.
//   • EVENTS come from the events table, filtered smart-by-type:
//       - shown: swim_meet, social, lesson, closure, holiday, generic event,
//                + external iCal-feed events (kind 'event')
//       - parties are shown GENERICALLY ("Pool reserved · private event") — the
//         host name is already stripped server-side; we never headline it.
//       - board 'meeting' is hidden (internal).
//   • PROGRAMS (swim lessons / practice) surface as today's sessions from their
//     weekday + time + date-range schedule.
//   • Recurring events (weekly/monthly) and imported iCal events are expanded so
//     they land on the right day.
// Usage:
//   PoolsideToday.render({ rootEl, events, programs, publicSettings, slug,
//                          checkinsCount, clubName });
//   PoolsideToday.update(events);   // call again when external feeds arrive
// =============================================================================
(function () {
  'use strict';

  var KIND_ICON = {
    event: '📅', party: '🎉', swim_meet: '🏊‍♀️', social: '🥳',
    closure: '🚫', holiday: '🎆', lesson: '🏫', meeting: '📋',
  };
  // Kinds that may appear in "Today". 'meeting' is intentionally absent
  // (internal). 'closure'/'holiday' also drive the hours line below.
  var SHOW_KINDS = { event: 1, party: 1, swim_meet: 1, social: 1, lesson: 1, closure: 1, holiday: 1 };
  var WEEKDAY_KEY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function startOfDay(d) { var x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function endOfDay(d) { var x = new Date(d); x.setHours(24, 0, 0, 0); return x; }

  function fmtTimeRange(start, end, allDay) {
    if (allDay) return 'All day';
    var opts = { hour: 'numeric', minute: '2-digit' };
    if (!end) return start.toLocaleTimeString(undefined, opts);
    return start.toLocaleTimeString(undefined, opts) + ' – ' + end.toLocaleTimeString(undefined, opts);
  }
  function fmtHour(hhmm) {
    if (!hhmm) return null;
    var m = String(hhmm).match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    var h = parseInt(m[1], 10); var mm = m[2];
    var ap = h < 12 ? 'AM' : 'PM';
    if (h === 0) h = 12; else if (h > 12) h -= 12;
    return mm === '00' ? (h + ' ' + ap) : (h + ':' + mm + ' ' + ap);
  }

  // Does this event have an occurrence on `now`'s local day? Returns the
  // occurrence's { start, end } (Date objects, today) or null. Handles single,
  // multi-day, and weekly/monthly recurrence. External feed events arrive
  // pre-expanded (no recurrence) so they're treated as single instances.
  function occursToday(ev, now) {
    if (!ev || !ev.starts_at) return null;
    var ds = startOfDay(now), de = endOfDay(now);
    var start = new Date(ev.starts_at);
    if (isNaN(start.getTime())) return null;
    var durMs = ev.ends_at ? (new Date(ev.ends_at).getTime() - start.getTime()) : 0;
    if (!(durMs >= 0)) durMs = 0;

    if (!ev.recurrence) {
      var end = new Date(start.getTime() + durMs);
      // overlap with today (covers multi-day spans)
      if (start < de && end >= ds) {
        return { start: start, end: ev.ends_at ? end : null };
      }
      return null;
    }

    // Recurring: only forward from the first occurrence, up to recurrence_until.
    if (startOfDay(start) > ds) return null;
    var until = ev.recurrence_until ? new Date(ev.recurrence_until) : new Date(now.getFullYear() + 2, 0, 1);
    if (until < ds) return null;
    var match = false;
    if (ev.recurrence === 'weekly') match = (start.getDay() === now.getDay());
    else if (ev.recurrence === 'monthly') match = (start.getDate() === now.getDate());
    if (!match) return null;
    var occStart = new Date(now); occStart.setHours(start.getHours(), start.getMinutes(), 0, 0);
    var occEnd = ev.ends_at ? new Date(occStart.getTime() + durMs) : null;
    return { start: occStart, end: occEnd };
  }

  // Program sessions (swim lessons / practice) scheduled for today.
  function programsToday(programs, now) {
    var out = [];
    var key = WEEKDAY_KEY[now.getDay()];
    var ds = startOfDay(now), de = endOfDay(now);
    (programs || []).forEach(function (p) {
      var days = String(p.weekdays || '').toLowerCase().split(',').map(function (s) { return s.trim(); });
      if (days.indexOf(key) === -1) return;
      if (p.start_date && startOfDay(new Date(p.start_date + 'T00:00:00')) > de) return;
      if (p.end_date && endOfDay(new Date(p.end_date + 'T00:00:00')) < ds) return;
      var start = new Date(now), end = null;
      var sm = String(p.start_time || '').match(/^(\d{1,2}):(\d{2})/);
      if (sm) start.setHours(parseInt(sm[1], 10), parseInt(sm[2], 10), 0, 0);
      else start.setHours(9, 0, 0, 0);
      var em = String(p.end_time || '').match(/^(\d{1,2}):(\d{2})/);
      if (em) { end = new Date(now); end.setHours(parseInt(em[1], 10), parseInt(em[2], 10), 0, 0); }
      out.push({ icon: '🏊', label: p.name || 'Program', sub: '', kind: 'lesson',
        start: start, end: end, allDay: false, location: p.location || '' });
    });
    return out;
  }

  function buildItems(events, programs, now) {
    var items = [];
    (events || []).forEach(function (ev) {
      if (!SHOW_KINDS[ev.kind] && !ev.external) return;     // meeting + unknowns hidden
      var occ = occursToday(ev, now);
      if (!occ) return;
      if (ev.kind === 'party') {
        items.push({ icon: '🎉', label: 'Pool reserved', sub: ' · private event', kind: 'party',
          start: occ.start, end: occ.end, allDay: !!ev.all_day, location: '' });
      } else {
        items.push({ icon: KIND_ICON[ev.kind] || '📅', label: ev.title || 'Event', sub: '', kind: ev.kind || 'event',
          start: occ.start, end: occ.end, allDay: !!ev.all_day, location: ev.location || '' });
      }
    });
    programsToday(programs, now).forEach(function (s) { items.push(s); });
    // All-day first, then chronological.
    items.sort(function (a, b) {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.start.getTime() - b.start.getTime();
    });
    return items;
  }

  function draw(ctx, events) {
    var rootEl = ctx.rootEl;
    if (!rootEl) return;
    var now = new Date();
    var ps = ctx.publicSettings || {};
    var items = buildItems(events, ctx.programs, now);

    // ── Hours line ───────────────────────────────────────────────────────
    var seasonClosed = ps.season && ps.season.open === false;
    var closureToday = items.filter(function (i) { return i.kind === 'closure' || i.kind === 'holiday'; })[0];
    var hoursIcon, hoursText, open = true;
    if (seasonClosed) {
      open = false; hoursIcon = '🚫';
      hoursText = (ps.season && ps.season.closed_message) ? ps.season.closed_message : 'Closed for the season';
    } else if (closureToday) {
      open = false; hoursIcon = '🚫';
      hoursText = 'Closed today' + (closureToday.label ? ' — ' + closureToday.label : '');
    } else {
      var o = fmtHour(ps.pool && ps.pool.opens_at), c = fmtHour(ps.pool && ps.pool.closes_at);
      if (o && c) { hoursIcon = '🏊'; hoursText = 'Open today · ' + o + ' – ' + c; }
      else { hoursIcon = '🗓️'; hoursText = "Today's schedule"; }
    }

    // ── Events list (closures already reflected in the hours line; drop them
    //    from the list so we don't say "closed" twice) ─────────────────────
    var listItems = items.filter(function (i) { return i.kind !== 'closure' && i.kind !== 'holiday'; });
    var itemsHtml;
    if (listItems.length) {
      itemsHtml = '<div style="margin-top:12px;display:flex;flex-direction:column;gap:8px">' +
        listItems.map(function (it) {
          var time = fmtTimeRange(it.start, it.end, it.allDay);
          var loc = it.location ? ('  ·  📍 ' + esc(it.location)) : '';
          return '<div style="display:flex;align-items:center;gap:11px;padding:10px 12px;background:var(--bg-2,#f7f3eb);border-radius:10px">' +
            '<span style="font-size:18px;line-height:1;flex-shrink:0">' + it.icon + '</span>' +
            '<div style="flex:1;min-width:0">' +
              '<div style="font-weight:600;font-size:14px;color:var(--text,#0f172a)">' + esc(it.label) +
                (it.sub ? '<span style="font-weight:500;color:var(--muted,#64748b)">' + esc(it.sub) + '</span>' : '') + '</div>' +
              '<div style="font-size:12.5px;color:var(--muted,#64748b)">' + esc(time) + loc + '</div>' +
            '</div></div>';
        }).join('') + '</div>';
    } else if (open) {
      itemsHtml = '<div style="margin-top:10px;font-size:13.5px;color:var(--muted,#64748b)">No special events today — just open swim. 🏊</div>';
    } else {
      itemsHtml = '';
    }

    // ── Check-in buzz counter ────────────────────────────────────────────
    var n = ctx.checkinsCount || 0;
    var counterHtml = n > 0
      ? '<div style="margin-top:6px;font-size:13px;color:var(--muted,#64748b)">👋 <b style="color:var(--blue,#0a3b5c)">' + n + '</b> checked in today</div>'
      : '';

    var dateStr = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    var heading = ctx.clubName ? ('Today at ' + esc(ctx.clubName)) : 'Today';

    rootEl.innerHTML =
      '<div style="background:#fff;border:1px solid var(--border,#e5e7eb);border-radius:16px;box-shadow:0 1px 2px rgba(10,59,92,.04),0 8px 24px rgba(10,59,92,.06);padding:18px 20px">' +
        '<div style="display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:6px">' +
          '<h2 style="font-family:\'Fraunces\',Georgia,serif;font-size:19px;color:var(--blue,#0a3b5c);margin:0">' + heading + '</h2>' +
          '<span style="font-size:12.5px;color:var(--muted,#64748b);font-weight:600">' + esc(dateStr) + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;font-size:14.5px;font-weight:600;color:' + (open ? 'var(--blue,#0a3b5c)' : '#b91c1c') + '">' +
          '<span style="font-size:17px;line-height:1">' + hoursIcon + '</span><span>' + esc(hoursText) + '</span>' +
        '</div>' +
        counterHtml +
        itemsHtml +
      '</div>';
  }

  var _ctx = null;
  window.PoolsideToday = {
    render: function (ctx) { _ctx = ctx || {}; draw(_ctx, _ctx.events || []); },
    update: function (events) { if (_ctx) draw(_ctx, events || _ctx.events || []); },
  };
})();

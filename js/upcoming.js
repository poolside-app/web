/* =============================================================================
 * upcoming.js — "Coming up": club events plus imported calendar events
 * =============================================================================
 * The member home's "Coming up" and the dashboard's "Upcoming events" only
 * counted events typed into Poolside, so a club that keeps its calendar in
 * Google showed "No upcoming events" above a calendar full of them (D9).
 *
 *   PoolsideUpcoming.merge(clubEvents, feeds, { now?, days?, limit? })
 *     clubEvents  events from tenant_public / events_admin
 *     feeds       external_calendar list_public feeds: [{ id, label, color, events: [...] }]
 *   → the next events, soonest first, shaped like club events.
 *
 * A feed event that happens on most days (Bishop's daily "Pool Open") is
 * left out, since the Today card already shows the hours, and a repeating
 * one (weekly practice) shows only its next date. Tested offline by
 * scripts/test_screens.mjs.
 * ============================================================================= */
(function (root) {
  'use strict';

  const DAY = 86400000;
  const dayKey = iso => (root.PoolTime ? root.PoolTime.dayKey(new Date(iso)) : String(iso).slice(0, 10));
  const endOf = e => Date.parse(e.ends_at || e.starts_at);

  function merge(clubEvents, feeds, opts) {
    const o = opts || {};
    const now = o.now != null ? o.now : Date.now();
    const until = now + (o.days != null ? o.days : 60) * DAY;
    const limit = o.limit != null ? o.limit : 5;
    const out = [];

    for (const ev of clubEvents || []) {
      if (endOf(ev) >= now && Date.parse(ev.starts_at) <= until) out.push(ev);
    }

    for (const f of feeds || []) {
      const series = new Map();   // one entry per calendar event, all its dates
      for (const e of f.events || []) {
        const k = e.uid || e.summary;
        if (!series.has(k)) series.set(k, []);
        series.get(k).push(e);
      }
      for (const list of series.values()) {
        const ahead = list.filter(e => endOf(e) >= now)
          .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
        const thisWeek = new Set(ahead.filter(e => Date.parse(e.starts_at) < now + 7 * DAY).map(e => dayKey(e.starts_at)));
        if (thisWeek.size >= 3) continue;   // daily-ish fixture, like pool hours
        const next = ahead.find(e => Date.parse(e.starts_at) <= until);
        if (!next) continue;
        out.push({
          id: `ext_${f.id}_${next.uid}_${next.starts_at}`,
          title: next.summary, body: next.description || '', location: next.location || '',
          starts_at: next.starts_at, ends_at: next.ends_at, all_day: !!next.all_day,
          kind: 'event', color: f.color, external: true,
          source_label: f.label, source_url: next.source_url || null,
        });
      }
    }

    out.sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
    return limit === Infinity ? out : out.slice(0, limit);
  }

  root.PoolsideUpcoming = { merge };
})(typeof window !== 'undefined' ? window : globalThis);

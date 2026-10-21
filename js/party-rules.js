/*
 * party-rules.js — which days and times a party can be booked (PLAN.md BJ4)
 *
 * The member page's copy of supabase/functions/_shared/party_rules.ts: the
 * club's party season, blocked dates (with the reason members see), days of
 * the week, start-time window and how far ahead. The two must give the same
 * answers; scripts/test_party_dates.mjs runs both over the same days.
 */
(function () {
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DEFAULT_EARLIEST = '08:00', DEFAULT_LATEST = '20:00';

  function date(v) { return typeof v === 'string' && DATE_RE.test(v) ? v : null; }
  function time(v) { return typeof v === 'string' && TIME_RE.test(v) ? v : null; }
  function whole(v, max) { var n = Number(v); return isFinite(n) && n >= 0 && n <= max ? Math.floor(n) : null; }

  function partyRules(p) {
    var v = p || {};
    var days = Array.isArray(v.days) ? v.days.map(Number).filter(function (d, i, a) { return d >= 0 && d <= 6 && Math.floor(d) === d && a.indexOf(d) === i; }).sort() : [];
    var notice = whole(v.notice_days, 365);
    return {
      from: date(v.from), until: date(v.until),
      blackouts: (Array.isArray(v.blackouts) ? v.blackouts : []).map(function (b) {
        var r = b || {}, from = date(r.from), to = date(r.to) || from;
        return from && to ? { from: from, to: to < from ? from : to, reason: String(r.reason == null ? '' : r.reason).trim().slice(0, 80) } : null;
      }).filter(Boolean),
      days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
      earliest: time(v.earliest), latest: time(v.latest),
      notice_days: notice === null ? 0 : notice,
      ahead_days: whole(v.ahead_days, 730),
    };
  }

  function dayNumber(day) { var p = day.split('-').map(Number); return Date.UTC(p[0], p[1] - 1, p[2]) / 86400000; }
  function shortDay(day) { var p = day.split('-').map(Number); return MONTHS[p[1] - 1] + ' ' + p[2]; }
  function clock(hhmm) {
    var p = hhmm.split(':').map(Number);
    return (p[0] % 12 || 12) + ':' + String(p[1]).padStart(2, '0') + ' ' + (p[0] < 12 ? 'AM' : 'PM');
  }

  function dayStatus(r, day, today) {
    if (!DATE_RE.test(day)) return { ok: false, reason: 'Pick a day' };
    if (day < today) return { ok: false, reason: 'That day has passed' };
    if (r.from && day < r.from) return { ok: false, reason: 'Parties start ' + shortDay(r.from) };
    if (r.until && day > r.until) return { ok: false, reason: 'The last party day is ' + shortDay(r.until) };
    var b = r.blackouts.filter(function (x) { return day >= x.from && day <= x.to; })[0];
    if (b) return { ok: false, reason: b.reason ? 'No parties: ' + b.reason : 'No parties that day' };
    var wd = new Date(dayNumber(day) * 86400000).getUTCDay();
    if (r.days.indexOf(wd) < 0) return { ok: false, reason: 'No parties on ' + WEEKDAYS[wd] + 's' };
    var ahead = dayNumber(day) - dayNumber(today);
    if (ahead < r.notice_days) return { ok: false, reason: 'Book at least ' + r.notice_days + ' day' + (r.notice_days === 1 ? '' : 's') + ' ahead' };
    if (r.ahead_days !== null && ahead > r.ahead_days) return { ok: false, reason: 'Book at most ' + r.ahead_days + ' day' + (r.ahead_days === 1 ? '' : 's') + ' ahead' };
    return { ok: true };
  }

  function startTimes(r) {
    function toMin(t) { var p = t.split(':').map(Number); return p[0] * 60 + p[1]; }
    var a = toMin(r.earliest || DEFAULT_EARLIEST), z = toMin(r.latest || DEFAULT_LATEST), out = [];
    for (var t = a; t <= z; t += 30) out.push(String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'));
    return out;
  }

  function timeStatus(r, hhmm) {
    if ((r.earliest && hhmm < r.earliest) || (r.latest && hhmm > r.latest)) {
      return { ok: false, reason: r.earliest && r.latest ? 'Parties start between ' + clock(r.earliest) + ' and ' + clock(r.latest)
        : r.earliest ? 'Parties start at ' + clock(r.earliest) + ' or later' : 'Parties start by ' + clock(r.latest) };
    }
    return { ok: true };
  }

  window.PartyRules = { partyRules: partyRules, dayStatus: dayStatus, startTimes: startTimes, timeStatus: timeStatus, clock: clock };
})();

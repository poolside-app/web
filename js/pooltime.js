/* =============================================================================
 * pooltime.js — every date and time on a club page is in the POOL's time zone
 * =============================================================================
 * Load it first, synchronously, on every club-facing page. It:
 *
 *   1. Makes the pool's zone the default for Date#toLocaleString /
 *      toLocaleDateString / toLocaleTimeString, so every existing
 *      `d.toLocaleTimeString(undefined, {...})` shows pool time whatever zone
 *      the phone is in. Calls that pass their own timeZone are left alone.
 *   2. Exposes window.PoolTime for the places that do date arithmetic or read
 *      and write <input type="datetime-local">.
 *
 * The zone arrives with the club details each page already loads
 * (tenant_public, member_auth.me, tenant_admin_auth.me) — pages call
 * PoolTime.setZone(tenant.timezone). It is remembered per club so the next
 * visit renders in pool time from the first paint.
 *
 * Date-only values ('YYYY-MM-DD': meeting dates, program dates, deadlines,
 * birthdays) are not instants. Format them with PoolTime.fmtDay(), never via
 * new Date(value) — that reads them as a moment and can land on the day
 * before.
 *
 * Server counterpart: supabase/functions/_shared/pool_time.ts.
 * ============================================================================= */
(function (root) {
  'use strict';

  var slug = 'default';
  try {
    var host = root.location && root.location.hostname || '';
    var m = host.match(/^([a-z0-9][a-z0-9-]*)\.poolsideapp\.com$/i);
    slug = m ? m[1].toLowerCase() : (host || 'default');
  } catch (_) { /* keep default */ }
  var KEY = 'poolside_tz:' + slug;

  function valid(z) {
    if (!z || typeof z !== 'string') return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch (_) { return false; }
  }
  function deviceZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
  }

  var tz = null;
  try { var saved = root.localStorage && root.localStorage.getItem(KEY); if (valid(saved)) tz = saved; } catch (_) { /* private mode */ }

  // ── 1. Pool time as the default for toLocale*String ──────────────────────
  var P = Date.prototype;
  var orig = { s: P.toLocaleString, d: P.toLocaleDateString, t: P.toLocaleTimeString };
  function withZone(opts) {
    if (!tz || (opts && opts.timeZone)) return opts;
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.timeZone = tz;
    return o;
  }
  P.toLocaleString = function (loc, opts) { return orig.s.call(this, loc, withZone(opts)); };
  P.toLocaleDateString = function (loc, opts) { return orig.d.call(this, loc, withZone(opts)); };
  P.toLocaleTimeString = function (loc, opts) { return orig.t.call(this, loc, withZone(opts)); };

  // ── 2. Arithmetic ───────────────────────────────────────────────────────
  var WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  var fmts = {};
  function zone() { return tz || deviceZone(); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /** Wall-clock reading at the pool: { year, month (1-12), day, hour, minute, second, weekday (0=Sun) }. */
  function parts(date) {
    var z = zone();
    var f = fmts[z] || (fmts[z] = new Intl.DateTimeFormat('en-US', {
      timeZone: z, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }));
    var o = {};
    f.formatToParts(new Date(date)).forEach(function (p) { o[p.type] = p.value; });
    return {
      year: +o.year, month: +o.month, day: +o.day,
      hour: +o.hour % 24, minute: +o.minute, second: +o.second,
      weekday: WD[o.weekday],
    };
  }
  function offsetMs(ms) {
    var p = parts(ms);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
  }
  /** The instant a pool wall-clock reading refers to (month is 1-12). */
  function fromWall(y, mo, d, h, mi, s) {
    var guess = Date.UTC(y, mo - 1, d, h || 0, mi || 0, s || 0);
    var a = guess - offsetMs(guess);
    var b = guess - offsetMs(a);
    return new Date(a === b ? a : Math.min(a, b));
  }
  function splitKey(key) { var a = String(key).split('-'); return [+a[0], +a[1], +a[2]]; }

  /** 'YYYY-MM-DD' of an instant at the pool. */
  function dayKey(date) { var p = parts(date); return p.year + '-' + pad(p.month) + '-' + pad(p.day); }
  function todayKey() { return dayKey(new Date()); }
  function addDays(key, n) {
    var k = splitKey(key), t = new Date(Date.UTC(k[0], k[1] - 1, k[2] + n));
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
  }
  function addMonths(key, n) {
    var k = splitKey(key), t = new Date(Date.UTC(k[0], k[1] - 1 + n, 1));
    var last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    return t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(Math.min(k[2], last));
  }
  function weekdayOfKey(key) { var k = splitKey(key); return new Date(Date.UTC(k[0], k[1] - 1, k[2])).getUTCDay(); }
  /** Midnight at the pool on a day ('YYYY-MM-DD' or any instant in it), as a Date. */
  function startOfDay(dayOrDate) {
    var k = splitKey(typeof dayOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayOrDate) ? dayOrDate : dayKey(dayOrDate));
    return fromWall(k[0], k[1], k[2], 0, 0, 0);
  }
  function endOfDay(dayOrDate) {
    var k = typeof dayOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayOrDate) ? dayOrDate : dayKey(dayOrDate);
    return startOfDay(addDays(k, 1));
  }
  /** Same pool day, different pool time of day. */
  function atTime(key, h, mi) { var k = splitKey(key); return fromWall(k[0], k[1], k[2], h, mi || 0, 0); }

  /** ISO instant → 'YYYY-MM-DDTHH:MM' for <input type="datetime-local">, in pool time. */
  function toInput(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = parts(d);
    return p.year + '-' + pad(p.month) + '-' + pad(p.day) + 'T' + pad(p.hour) + ':' + pad(p.minute);
  }
  /** 'YYYY-MM-DDTHH:MM' typed as pool time → ISO instant, or null. */
  function fromInput(v) {
    var m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return null;
    return fromWall(+m[1], +m[2], +m[3], +m[4], +m[5], 0).toISOString();
  }
  /** Format a date-only 'YYYY-MM-DD' without ever shifting its day. */
  /** The pool's hours on a day ('YYYY-MM-DD'): { opens, closes } as 'HH:MM',
   *  or null when it's closed that day. Settings holds the usual hours and,
   *  optionally, hours for particular weekdays (pool.hours_by_day, keyed
   *  0 = Sunday … 6 = Saturday; { closed: true } for a closed day). J6. */
  function hoursFor(pool, key) {
    pool = pool || {};
    var byDay = pool.hours_by_day || {};
    var d = byDay[String(weekdayOfKey(key))];
    if (d && d.closed) return null;
    var opens = (d && d.opens) || pool.opens_at, closes = (d && d.closes) || pool.closes_at;
    return opens && closes ? { opens: opens, closes: closes } : null;
  }
  function fmtDay(key, opts) {
    if (!key) return '';
    var m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return String(key);
    var o = {};
    if (opts) for (var k in opts) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];
    o.timeZone = 'UTC';
    return orig.d.call(new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), undefined, o);
  }

  function setZone(z) {
    if (!valid(z) || z === tz) return;
    tz = z;
    fmts = {};
    try { root.localStorage && root.localStorage.setItem(KEY, z); } catch (_) { /* private mode */ }
  }

  root.PoolTime = {
    setZone: setZone, zone: zone,
    parts: parts, dayKey: dayKey, todayKey: todayKey,
    addDays: addDays, addMonths: addMonths, weekdayOfKey: weekdayOfKey,
    fromWall: fromWall, atTime: atTime, startOfDay: startOfDay, endOfDay: endOfDay,
    toInput: toInput, fromInput: fromInput, fmtDay: fmtDay, hoursFor: hoursFor,
  };
})(typeof window !== 'undefined' ? window : globalThis);

// =============================================================================
// party_rules.ts — which days and times a party can be booked (PLAN.md BJ4)
// =============================================================================
// Doug's walkthrough list, 10/21: the pool can be open on a day the club
// doesn't want parties (an unheated October week). So parties have their own
// season, separate from the pool's: a first and last party day, blocked dates
// with a reason members see ("No parties: swim meet"), the days of the week,
// a start-time window, and how far ahead (at least / at most N days).
// Nothing set means no limits, as before.
//
// js/party-rules.js is the member page's copy and must give the same answers;
// scripts/test_party_dates.mjs runs both over the same days.
// =============================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DEFAULT_EARLIEST = '08:00';
export const DEFAULT_LATEST = '20:00';

export type Blackout = { from: string; to: string; reason: string };
export type PartyRules = {
  from: string | null; until: string | null; blackouts: Blackout[]; days: number[];
  earliest: string | null; latest: string | null; notice_days: number; ahead_days: number | null;
};
export type Status = { ok: true; reason?: undefined } | { ok: false; reason: string };

const date = (v: unknown) => (typeof v === 'string' && DATE_RE.test(v) ? v : null);
const time = (v: unknown) => (typeof v === 'string' && TIME_RE.test(v) ? v : null);
const whole = (v: unknown, max: number) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.floor(n) : null; };

/** The club's rules from settings.parties, with anything malformed left out. */
export function partyRules(p: unknown): PartyRules {
  const v = (p ?? {}) as Record<string, unknown>;
  const days = Array.isArray(v.days) ? [...new Set(v.days.map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
  return {
    from: date(v.from), until: date(v.until),
    blackouts: (Array.isArray(v.blackouts) ? v.blackouts : []).map(b => {
      const r = (b ?? {}) as Record<string, unknown>;
      const from = date(r.from), to = date(r.to) ?? from;
      return from && to ? { from, to: to < from ? from : to, reason: String(r.reason ?? '').trim().slice(0, 80) } : null;
    }).filter((b): b is Blackout => !!b),
    days: days.length ? days : [0, 1, 2, 3, 4, 5, 6],
    earliest: time(v.earliest), latest: time(v.latest),
    notice_days: whole(v.notice_days, 365) ?? 0,
    ahead_days: whole(v.ahead_days, 730),
  };
}

function dayNumber(day: string): number { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }
function shortDay(day: string): string { const [, m, d] = day.split('-').map(Number); return `${MONTHS[m - 1]} ${d}`; }
export function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Can a party be booked on this pool day? If not, the reason a member sees. */
export function dayStatus(r: PartyRules, day: string, today: string): Status {
  if (!DATE_RE.test(day)) return { ok: false, reason: 'Pick a day' };
  if (day < today) return { ok: false, reason: 'That day has passed' };
  if (r.from && day < r.from) return { ok: false, reason: `Parties start ${shortDay(r.from)}` };
  if (r.until && day > r.until) return { ok: false, reason: `The last party day is ${shortDay(r.until)}` };
  const b = r.blackouts.find(x => day >= x.from && day <= x.to);
  if (b) return { ok: false, reason: b.reason ? `No parties: ${b.reason}` : 'No parties that day' };
  const wd = new Date(dayNumber(day) * 86400000).getUTCDay();
  if (!r.days.includes(wd)) return { ok: false, reason: `No parties on ${WEEKDAYS[wd]}s` };
  const ahead = dayNumber(day) - dayNumber(today);
  if (ahead < r.notice_days) return { ok: false, reason: `Book at least ${r.notice_days} day${r.notice_days === 1 ? '' : 's'} ahead` };
  if (r.ahead_days !== null && ahead > r.ahead_days) return { ok: false, reason: `Book at most ${r.ahead_days} day${r.ahead_days === 1 ? '' : 's'} ahead` };
  return { ok: true };
}

/** The start times a member can pick: every 30 minutes in the club's window
 *  (8 AM to 8 PM when it sets none). */
export function startTimes(r: PartyRules): string[] {
  const toMin = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const a = toMin(r.earliest ?? DEFAULT_EARLIEST), z = toMin(r.latest ?? DEFAULT_LATEST);
  const out: string[] = [];
  for (let t = a; t <= z; t += 30) out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  return out;
}

/** Is this start inside the club's window? Only a window the club set counts. */
export function timeStatus(r: PartyRules, hhmm: string): Status {
  if (r.earliest && hhmm < r.earliest || r.latest && hhmm > r.latest) {
    return { ok: false, reason: r.earliest && r.latest ? `Parties start between ${clock(r.earliest)} and ${clock(r.latest)}`
      : r.earliest ? `Parties start at ${clock(r.earliest)} or later` : `Parties start by ${clock(r.latest!)}` };
  }
  return { ok: true };
}

/** The server's check on a request: the day, then the time. null when it's fine. */
export function checkPartyStart(r: PartyRules, day: string, hhmm: string, today: string): string | null {
  const d = dayStatus(r, day, today);
  if (!d.ok) return d.reason;
  const t = timeStatus(r, hhmm);
  return t.ok ? null : t.reason;
}

/** The board's settings, checked before they're saved. */
export function cleanRules(input: unknown): { ok: true; rules: PartyRules } | { ok: false; error: string } {
  const v = (input ?? {}) as Record<string, unknown>;
  const blank = (x: unknown) => x === null || x === undefined || x === '';
  if (!blank(v.from) && !date(v.from)) return { ok: false, error: "The first party day isn't a date." };
  if (!blank(v.until) && !date(v.until)) return { ok: false, error: "The last party day isn't a date." };
  if (date(v.from) && date(v.until) && date(v.from)! > date(v.until)!) return { ok: false, error: 'The first party day is after the last.' };
  if (!blank(v.earliest) && !time(v.earliest)) return { ok: false, error: "The earliest start isn't a time." };
  if (!blank(v.latest) && !time(v.latest)) return { ok: false, error: "The latest start isn't a time." };
  if (time(v.earliest) && time(v.latest) && time(v.earliest)! > time(v.latest)!) return { ok: false, error: 'The earliest start is after the latest.' };
  if (v.days !== undefined && (!Array.isArray(v.days) || !v.days.some(d => Number.isInteger(Number(d)) && Number(d) >= 0 && Number(d) <= 6))) {
    return { ok: false, error: 'Pick at least one day of the week.' };
  }
  if (!blank(v.notice_days) && whole(v.notice_days, 365) === null) return { ok: false, error: 'At least how many days ahead? 0 to 365.' };
  if (!blank(v.ahead_days) && whole(v.ahead_days, 730) === null) return { ok: false, error: 'At most how many days ahead? 0 to 730.' };
  const bl = Array.isArray(v.blackouts) ? v.blackouts : [];
  if (bl.length > 100) return { ok: false, error: 'At most 100 blocked dates.' };
  for (const b of bl) {
    const r = (b ?? {}) as Record<string, unknown>;
    if (!date(r.from) || (!blank(r.to) && !date(r.to))) return { ok: false, error: 'Each blocked date needs a date.' };
    if (date(r.to) && date(r.to)! < date(r.from)!) return { ok: false, error: 'A blocked date range ends before it starts.' };
  }
  return { ok: true, rules: partyRules(v) };
}

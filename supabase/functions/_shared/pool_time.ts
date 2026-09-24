// Pool time: every date and time the server writes or reasons about is in the
// club's own time zone (tenants.timezone), never the server's UTC clock.
// Pure functions over Intl, so they run the same in Deno and in Node tests.
//
// Browser counterpart: js/pooltime.js.

export const DEFAULT_TZ = 'America/Los_Angeles';

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** A tenants.timezone value, or the default when it's missing or unusable. */
export function zoneOrDefault(tz: unknown): string {
  return validTimeZone(tz) ? tz : DEFAULT_TZ;
}

// deno-lint-ignore no-explicit-any
export async function tenantTimeZone(sb: any, tenantId: string): Promise<string> {
  const { data } = await sb.from('tenants').select('timezone').eq('id', tenantId).maybeSingle();
  return zoneOrDefault(data?.timezone);
}

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFmt.set(tz, f);
  }
  return f;
}

export type WallParts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The pool's wall-clock reading at an instant. */
export function wallParts(instant: Date | string | number, tz: string): WallParts {
  const o: Record<string, string> = {};
  for (const p of fmtFor(tz).formatToParts(new Date(instant))) o[p.type] = p.value;
  return {
    year: +o.year, month: +o.month, day: +o.day,
    hour: +o.hour % 24, minute: +o.minute, second: +o.second,
  };
}

function offsetMs(instantMs: number, tz: string): number {
  const p = wallParts(instantMs, tz);
  const whole = Math.floor(instantMs / 1000) * 1000;
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - whole;
}

/** The instant a wall-clock reading at the pool refers to. A reading inside
 *  the skipped spring-forward hour resolves to the real time an hour off; one
 *  inside the repeated fall-back hour takes the first of the two. */
export function wallTimeToUtc(
  year: number, month: number, day: number,
  hour = 0, minute = 0, second = 0, tz: string = DEFAULT_TZ,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = guess - offsetMs(guess, tz);
  const second2 = guess - offsetMs(first, tz);
  return new Date(first === second2 ? first : Math.min(first, second2));
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of an instant at the pool. */
export function poolDate(instant: Date | string | number, tz: string): string {
  const p = wallParts(instant, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** Today's date at the pool, 'YYYY-MM-DD'. */
export function poolToday(tz: string, now: Date = new Date()): string {
  return poolDate(now, tz);
}

/** The pool day an instant falls on, as [start, end) instants. */
export function poolDayBounds(instant: Date | string | number, tz: string): { key: string; startIso: string; endIso: string } {
  const key = poolDate(instant, tz);
  const [y, m, d] = key.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    key,
    startIso: wallTimeToUtc(y, m, d, 0, 0, 0, tz).toISOString(),
    endIso: wallTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, 0, tz).toISOString(),
  };
}

// ICU puts a narrow no-break space before AM/PM. Plain spaces keep texts in
// GSM-7 (one segment) and survive the PDF font, which can't draw U+202F.
const plainSpaces = (s: string) => s.replace(/[\u202f\u2009\u00a0]/g, ' ');

export function fmtPoolDate(
  instant: Date | string | number, tz: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'full' },
): string {
  return plainSpaces(new Date(instant).toLocaleDateString('en-US', { ...opts, timeZone: tz }));
}

export function fmtPoolTime(
  instant: Date | string | number, tz: string,
  opts: Intl.DateTimeFormatOptions = { timeStyle: 'short' },
): string {
  return plainSpaces(new Date(instant).toLocaleTimeString('en-US', { ...opts, timeZone: tz }));
}

/** Date and time with the zone named, for records: "Sep 23, 2026, 7:49:22 PM PDT". */
export function fmtPoolStamp(instant: Date | string | number, tz: string): string {
  return plainSpaces(new Date(instant).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'long' }));
}

/** The two variables every party email template uses. */
export function partyWhen(startsAt: Date | string, tz: string): { party_date: string; party_time: string } {
  return { party_date: fmtPoolDate(startsAt, tz), party_time: fmtPoolTime(startsAt, tz) };
}

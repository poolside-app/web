// Minimal iCal parser for external calendar feeds, time-zone aware.
// Handles the subset Google Calendar and Swimtopia emit:
//   • VEVENT blocks (SUMMARY, DESCRIPTION, DTSTART, DTEND, LOCATION, UID, STATUS, URL)
//   • Line unfolding (RFC 5545 §3.1)
//   • DTSTART/DTEND as DATE (all-day), UTC ("…Z"), zoned (TZID=…) or floating
//   • RRULE FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL,
//     BYDAY and BYSETPOS; EXDATE; STATUS:CANCELLED → skipped
//
// Times: repeats are expanded on the event's own wall clock ("every Friday at
// 6 PM" stays a Friday and stays 6 PM across daylight-saving changes), then
// each instance is converted to UTC with that zone. Floating times, and UTC
// times on a repeating event, are read in the pool's zone. All-day events stay
// anchored at noon UTC on their date, which is the same date in every US zone.
//
// Internally a "naive" Date holds a wall-clock reading in its UTC fields, so
// UTC arithmetic on it is wall-clock arithmetic.

import { validTimeZone, wallParts, wallTimeToUtc } from './pool_time.ts';

export type ParsedEvent = {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  starts_at: string;        // ISO 8601 UTC
  ends_at?: string;
  all_day: boolean;
  source_url?: string;
};

type IcalValue = { naive: Date; all_day: boolean };

function unfoldLines(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeIcal(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function naiveOf(instant: Date, zone: string): Date {
  const p = wallParts(instant, zone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second));
}

// "20260712" (all-day) · "20260712T143000Z" (UTC) · "20260712T143000" (zoned
// by TZID, or floating) → a wall-clock reading in `zone`.
function parseIcalValue(value: string, isDateOnly: boolean, zone: string): IcalValue | null {
  if (!value) return null;
  if (isDateOnly || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { naive: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0)), all_day: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const utcMs = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return { naive: m[7] ? naiveOf(new Date(utcMs), zone) : new Date(utcMs), all_day: false };
}

function toUtc(naive: Date, zone: string, allDay: boolean): Date {
  if (allDay) return naive;
  return wallTimeToUtc(naive.getUTCFullYear(), naive.getUTCMonth() + 1, naive.getUTCDate(),
    naive.getUTCHours(), naive.getUTCMinutes(), naive.getUTCSeconds(), zone);
}

// "DTSTART;TZID=America/Los_Angeles:20260712T143000"
// → name="DTSTART", params={TZID:"America/Los_Angeles"}, value="20260712T143000"
function splitProp(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const left = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = left.split(';');
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

const zoneOf = (params: Record<string, string>, fallback: string) =>
  validTimeZone(params.TZID) ? params.TZID : fallback;

// Expand a repeating event in naive wall-clock time within [windowStart, windowEnd].
function expandRrule(
  rrule: string,
  baseStart: Date,
  baseEnd: Date | null,
  windowStart: Date,
  windowEnd: Date,
  zone: string,
): Array<{ start: Date; end: Date | null }> {
  const fields: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const freq = fields.FREQ;
  const interval = Math.max(1, parseInt(fields.INTERVAL || '1', 10));
  const count = fields.COUNT ? parseInt(fields.COUNT, 10) : null;
  let until: Date | null = null;
  if (fields.UNTIL) {
    const parsed = parseIcalValue(fields.UNTIL, false, zone);
    if (parsed) until = parsed.naive;
  }
  const duration = baseEnd ? baseEnd.getTime() - baseStart.getTime() : 0;
  const byday = (fields.BYDAY || '').split(',').filter(Boolean);
  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const targetDays = byday.map(d => dayMap[d.slice(-2).toUpperCase()]).filter(d => d !== undefined);
  const bySetPos = (fields.BYSETPOS || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));

  const out: Array<{ start: Date; end: Date | null }> = [];
  const cur = new Date(baseStart);
  let safetyCounter = 0;

  const withTimeOf = (target: Date, ref: Date): Date => {
    const d = new Date(target);
    d.setUTCHours(ref.getUTCHours(), ref.getUTCMinutes(), ref.getUTCSeconds(), 0);
    return d;
  };
  const emit = (i2: Date) => {
    if (i2.getTime() < baseStart.getTime() || i2.getTime() > windowEnd.getTime()) return;
    if (until && i2 > until) return;
    if (count !== null && out.length >= count) return;
    out.push({ start: i2, end: duration ? new Date(i2.getTime() + duration) : null });
  };

  while (cur.getTime() <= windowEnd.getTime() && safetyCounter < 500) {
    safetyCounter++;
    if (until && cur > until) break;
    if (count !== null && out.length >= count) break;

    if (cur.getTime() >= windowStart.getTime() - 86400_000) {
      if (freq === 'WEEKLY' && targetDays.length > 0) {
        const weekStart = new Date(cur);
        weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
        for (const d of targetDays) {
          const inst = new Date(weekStart);
          inst.setUTCDate(weekStart.getUTCDate() + d);
          emit(withTimeOf(inst, cur));
        }
      } else if (freq === 'MONTHLY' && targetDays.length > 0) {
        const year = cur.getUTCFullYear();
        const month = cur.getUTCMonth();
        const matches: Date[] = [];
        for (let day = 1; day <= 31; day++) {
          const d = new Date(Date.UTC(year, month, day));
          if (d.getUTCMonth() !== month) break;
          if (targetDays.includes(d.getUTCDay())) matches.push(d);
        }
        let picked: Date[] = matches;
        if (bySetPos.length > 0) {
          picked = bySetPos
            .map(p => p > 0 ? matches[p - 1] : matches[matches.length + p])
            .filter((d): d is Date => d instanceof Date);
        }
        for (const inst of picked) emit(withTimeOf(inst, cur));
      } else {
        out.push({ start: new Date(cur), end: duration ? new Date(cur.getTime() + duration) : null });
      }
    }
    switch (freq) {
      case 'DAILY':   cur.setUTCDate(cur.getUTCDate() + interval); break;
      case 'WEEKLY':  cur.setUTCDate(cur.getUTCDate() + 7 * interval); break;
      case 'MONTHLY': cur.setUTCMonth(cur.getUTCMonth() + interval); break;
      case 'YEARLY':  cur.setUTCFullYear(cur.getUTCFullYear() + interval); break;
      default: return out;
    }
  }
  return out;
}

/** Parse a feed. `poolTz` reads floating times and the wall clock of
 *  repeating UTC events. Only instances inside the window are returned. */
export function parseIcal(text: string, windowStart: Date, windowEnd: Date, poolTz: string): ParsedEvent[] {
  const lines = unfoldLines(text);
  const events: ParsedEvent[] = [];
  let inEvent = false;
  let cur: Record<string, string> = {};
  let rrule: string | null = null;
  let dtstartParams: Record<string, string> = {};
  let dtendParams: Record<string, string> = {};
  // EXDATE instances of a series, as naive wall-clock dates (YYYY-MM-DD).
  let exDates: Array<{ value: string; params: Record<string, string> }> = [];

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true; cur = {}; rrule = null; dtstartParams = {}; dtendParams = {}; exDates = [];
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      if ((cur.STATUS || '').toUpperCase() === 'CANCELLED') continue;
      const zone = zoneOf(dtstartParams, poolTz);
      const isDateOnly = (dtstartParams.VALUE || '').toUpperCase() === 'DATE';
      const dtstart = parseIcalValue(cur.DTSTART, isDateOnly, zone);
      if (!dtstart) continue;
      const dtend = cur.DTEND
        ? parseIcalValue(cur.DTEND, (dtendParams.VALUE || '').toUpperCase() === 'DATE' || isDateOnly, zoneOf(dtendParams, zone))
        : null;
      const allDay = dtstart.all_day;
      const naiveWindowStart = naiveOf(windowStart, zone);
      const naiveWindowEnd = naiveOf(windowEnd, zone);
      const excluded = new Set(exDates.map(x => {
        const v = parseIcalValue(x.value, (x.params.VALUE || '').toUpperCase() === 'DATE', zoneOf(x.params, zone));
        return v ? v.naive.toISOString().slice(0, 10) : '';
      }));

      const buildEvent = (naiveStart: Date, naiveEnd: Date | null): ParsedEvent => {
        const start = toUtc(naiveStart, zone, allDay);
        const end = naiveEnd ? toUtc(naiveEnd, zone, allDay) : null;
        return {
          uid: cur.UID || `${cur.SUMMARY || 'event'}-${start.toISOString()}`,
          summary: unescapeIcal(cur.SUMMARY || '(untitled event)'),
          description: cur.DESCRIPTION ? unescapeIcal(cur.DESCRIPTION) : undefined,
          location: cur.LOCATION ? unescapeIcal(cur.LOCATION) : undefined,
          starts_at: start.toISOString(),
          ends_at: end ? end.toISOString() : undefined,
          all_day: allDay,
          source_url: cur.URL || undefined,
        };
      };

      if (rrule) {
        for (const inst of expandRrule(rrule, dtstart.naive, dtend?.naive ?? null, naiveWindowStart, naiveWindowEnd, zone)) {
          if (excluded.has(inst.start.toISOString().slice(0, 10))) continue;
          events.push(buildEvent(inst.start, inst.end));
        }
      } else if (dtstart.naive.getTime() >= naiveWindowStart.getTime() && dtstart.naive.getTime() <= naiveWindowEnd.getTime()) {
        events.push(buildEvent(dtstart.naive, dtend?.naive ?? null));
      }
      continue;
    }
    if (!inEvent) continue;
    const prop = splitProp(line);
    if (!prop) continue;
    if (prop.name === 'RRULE') rrule = prop.value;
    else if (prop.name === 'DTSTART') { cur.DTSTART = prop.value; dtstartParams = prop.params; }
    else if (prop.name === 'DTEND') { cur.DTEND = prop.value; dtendParams = prop.params; }
    else if (prop.name === 'EXDATE') {
      for (const v of prop.value.split(',')) exDates.push({ value: v.trim(), params: prop.params });
    }
    else cur[prop.name] = prop.value;
  }
  return events;
}

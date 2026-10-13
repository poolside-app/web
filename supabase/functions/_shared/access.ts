// =============================================================================
// access.ts — access levels and passes (PLAN.md AR, Doug 10/13)
// =============================================================================
// A club's levels say which doors a kind of keyfob opens and when. They're
// in settings.access and edited on the Keyfobs tab:
//   levels: [{ key, name, doors: [door keys], days: [0=Sun..6=Sat],
//              start: 'HH:MM' | null, end: 'HH:MM' | null, until: 'YYYY-MM-DD' | null }]
//   party_doors: [door keys a party host gets on party day]
// A club that set nothing: members get the front gate any time, the board
// every door. Bishop (from its old keyfob program): Member is Main Gate and
// the restrooms 6:00 AM-8:30 PM until Oct 31; Board is every door any time.
//
// The member app's Unlock follows the Member level. A pass (access_passes)
// gives a family extra doors for a set time, opened from the app; a paid
// party gives its family the party doors from the pool's opening to closing
// that day. Keyfob-only doors (gate_doors.ts, remote: false) are in levels
// but never opened from the app.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { doorsFor, remoteDoors, doorsReady, MAIN_GATE, type Door } from './gate_doors.ts';
import { wallParts, wallTimeToUtc, poolDate, zoneOrDefault } from './pool_time.ts';

export type Level = { key: string; name: string; doors: string[]; days: number[]; start: string | null; end: string | null; until: string | null };
export type AccessConfig = { levels: Level[]; party_doors: string[] };
export type Pass = { id: string; doors: string[]; starts_at: string; ends_at: string; ended_at?: string | null; household_id?: string; note?: string | null };

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const KEY_RE = /^[a-z0-9_]{1,32}$/;
const MAX_PASS_MS = 366 * 86400e3;

function defaults(doorsRaw: unknown): AccessConfig {
  const all = doorsFor(doorsRaw).map(d => d.key);
  return {
    levels: [
      { key: 'member', name: 'Member', doors: [MAIN_GATE], days: ALL_DAYS, start: null, end: null, until: null },
      { key: 'board', name: 'Board', doors: all, days: ALL_DAYS, start: null, end: null, until: null },
    ],
    party_doors: [],
  };
}

function cleanLevel(raw: unknown, known: Set<string>): { ok: true; level: Level } | { ok: false; error: string } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const key = String(r.key ?? '');
  if (!KEY_RE.test(key)) return { ok: false, error: 'A level needs a key.' };
  const name = String(r.name ?? '').trim().slice(0, 40) || key;
  const doors = [...new Set((Array.isArray(r.doors) ? r.doors : []).map(String).filter(d => known.has(d)))];
  const days = [...new Set((Array.isArray(r.days) ? r.days : ALL_DAYS).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
  const t = (v: unknown) => (v === null || v === undefined || v === '') ? null : String(v).slice(0, 5);
  const start = t(r.start), end = t(r.end);
  if ((start && !TIME_RE.test(start)) || (end && !TIME_RE.test(end))) return { ok: false, error: `${name}: times are like 06:00 or 20:30.` };
  if (!!start !== !!end) return { ok: false, error: `${name}: give both a from and a to time, or neither for any time.` };
  if (start && end && start === end) return { ok: false, error: `${name}: the from and to times are the same.` };
  const until = (r.until === null || r.until === undefined || r.until === '') ? null : String(r.until);
  if (until && !DATE_RE.test(until)) return { ok: false, error: `${name}: the end date isn't a date.` };
  if (!days.length) return { ok: false, error: `${name}: pick at least one day.` };
  return { ok: true, level: { key, name, doors, days, start, end, until } };
}

/** The club's levels and party doors, with defaults for anything not set. */
export function accessConfig(settingsValue: unknown, doorsRaw: unknown): AccessConfig {
  const d = defaults(doorsRaw);
  const a = ((settingsValue ?? {}) as Record<string, unknown>).access as Record<string, unknown> | undefined;
  if (!a) return d;
  const known = new Set(doorsFor(doorsRaw).map(x => x.key));
  const levels: Level[] = [];
  for (const raw of Array.isArray(a.levels) ? a.levels : []) {
    const c = cleanLevel(raw, known);
    if (c.ok && !levels.some(l => l.key === c.level.key)) levels.push(c.level);
  }
  for (const base of d.levels) if (!levels.some(l => l.key === base.key)) levels.push(base);
  levels.sort((x, y) => (x.key === 'member' ? -1 : y.key === 'member' ? 1 : x.key === 'board' ? -1 : y.key === 'board' ? 1 : 0));
  const remote = new Set(remoteDoors(doorsRaw).map(x => x.key));
  const party_doors = [...new Set((Array.isArray(a.party_doors) ? a.party_doors : []).map(String).filter(k => remote.has(k)))];
  return { levels, party_doors };
}

/** For saving from the Keyfobs tab: checked and cleaned, or why not. */
export function cleanAccess(input: unknown, doorsRaw: unknown): { ok: true; value: AccessConfig } | { ok: false; error: string } {
  const r = (input ?? {}) as Record<string, unknown>;
  const known = new Set(doorsFor(doorsRaw).map(x => x.key));
  const levels: Level[] = [];
  for (const raw of Array.isArray(r.levels) ? r.levels : []) {
    const c = cleanLevel(raw, known);
    if (!c.ok) return c;
    if (!levels.some(l => l.key === c.level.key)) levels.push(c.level);
  }
  if (!levels.some(l => l.key === 'member')) return { ok: false, error: 'The Member level is missing.' };
  const remote = new Set(remoteDoors(doorsRaw).map(x => x.key));
  const party_doors = [...new Set((Array.isArray(r.party_doors) ? r.party_doors : []).map(String).filter(k => remote.has(k)))];
  return { ok: true, value: { levels, party_doors } };
}

// ── Reading a level ─────────────────────────────────────────────────────
function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
export function hoursText(level: Level): string {
  return level.start && level.end ? `${clock(level.start)}–${clock(level.end)}` : 'any time';
}
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function daysText(days: number[]): string {
  const s = [...days].sort().join();
  if (s === '0,1,2,3,4,5,6') return 'every day';
  if (s === '1,2,3,4,5') return 'weekdays';
  if (s === '0,6') return 'weekends';
  return [...days].sort().map(d => DAY[d]).join(', ');
}
function dateText(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Main Gate, Mens, Womens · every day 6:00 AM–8:30 PM · until Oct 31, 2026" */
export function describeLevel(level: Level, doorsRaw: unknown): string {
  const all = doorsFor(doorsRaw);
  const doors = level.doors.length && level.doors.length === all.length && all.length > 1 ? 'Every door'
    : all.filter(d => level.doors.includes(d.key)).map(d => d.name).join(', ') || 'No doors';
  const when = level.start && level.end ? `${daysText(level.days)} ${hoursText(level)}`
    : level.days.length === 7 ? 'any time' : daysText(level.days);
  return [doors, when, level.until ? `until ${dateText(level.until)}` : ''].filter(Boolean).join(' · ');
}

/** Is a level open at an instant, at the pool? If not, why, and when it opens. */
export function levelOpenAt(level: Level, tz: string, now: Date): { open: boolean; why?: 'ended' | 'day' | 'hours'; opens?: string } {
  const today = poolDate(now, tz);
  if (level.until && today > level.until) return { open: false, why: 'ended' };
  const p = wallParts(now, tz);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const opens = level.start ? clock(level.start) : undefined;
  if (!level.days.includes(dow)) return { open: false, why: 'day', opens };
  if (!level.start || !level.end) return { open: true };
  const t = p.hour * 60 + p.minute;
  const [sh, sm] = level.start.split(':').map(Number), [eh, em] = level.end.split(':').map(Number);
  const s = sh * 60 + sm, e = eh * 60 + em;
  const inside = s < e ? (t >= s && t < e) : (t >= s || t < e);     // an overnight window wraps
  return inside ? { open: true } : { open: false, why: 'hours', opens };
}

const activeAt = (p: Pass, now: Date) => !p.ended_at && Date.parse(p.starts_at) <= now.getTime() && now.getTime() < Date.parse(p.ends_at);

/** What a member can open from the app right now, and, if the front gate
 *  is closed to members, when it opens. */
export function memberDoorsNow(a: { config: AccessConfig; doorsRaw: unknown; bridgeVersion: string | null | undefined; passes: Pass[]; tz: string; now: Date }):
  { doors: Array<{ key: string; name: string; via: 'member' | 'pass'; pass_id?: string; until?: string }>; gateClosed: null | { opens?: string; hours: string; why?: string } } {
  const remote = remoteDoors(a.doorsRaw);
  const usable = (d: Door) => d.key === MAIN_GATE || doorsReady(a.bridgeVersion);
  const member = a.config.levels.find(l => l.key === 'member');
  const state = member ? levelOpenAt(member, a.tz, a.now) : { open: false };
  const out: Array<{ key: string; name: string; via: 'member' | 'pass'; pass_id?: string; until?: string }> = [];
  if (member && state.open) {
    for (const d of remote) if (member.doors.includes(d.key) && usable(d)) out.push({ key: d.key, name: d.name, via: 'member' });
  }
  for (const p of a.passes.filter(x => activeAt(x, a.now)).sort((x, y) => Date.parse(y.ends_at) - Date.parse(x.ends_at))) {
    for (const d of remote) {
      if (!p.doors.includes(d.key) || !usable(d) || out.some(o => o.key === d.key)) continue;
      out.push({ key: d.key, name: d.name, via: 'pass', pass_id: p.id, until: p.ends_at });
    }
  }
  const order = remote.map(d => d.key);
  out.sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  const gateOpen = out.some(o => o.key === MAIN_GATE);
  const gateClosed = member && member.doors.includes(MAIN_GATE) && !gateOpen
    ? { opens: (state as { opens?: string }).opens, hours: hoursText(member), why: (state as { why?: string }).why } : null;
  return { doors: out, gateClosed };
}

/** A pass the board gives: doors that open remotely, a start before its
 *  end, an end still to come, at most a year. */
export function validatePass(p: { doors: unknown; starts_at: unknown; ends_at: unknown }, doorsRaw: unknown, now: Date): { ok: true; doors: string[]; starts_at: string; ends_at: string } | { ok: false; error: string } {
  const remote = new Set(remoteDoors(doorsRaw).map(d => d.key));
  const doors = [...new Set((Array.isArray(p.doors) ? p.doors : []).map(String))];
  if (!doors.length) return { ok: false, error: 'Pick at least one door.' };
  const bad = doors.filter(d => !remote.has(d));
  if (bad.length) return { ok: false, error: 'A pass can only use doors the app can open.' };
  const s = Date.parse(String(p.starts_at ?? '')), e = Date.parse(String(p.ends_at ?? ''));
  if (!Number.isFinite(s) || !Number.isFinite(e)) return { ok: false, error: 'Give a from and a to.' };
  if (e <= s) return { ok: false, error: 'The pass has to end after it starts.' };
  if (e <= now.getTime()) return { ok: false, error: 'That time has already passed.' };
  if (e - s > MAX_PASS_MS) return { ok: false, error: 'A pass can last a year at most.' };
  return { ok: true, doors, starts_at: new Date(s).toISOString(), ends_at: new Date(e).toISOString() };
}

/** A party's pass: the pool's opening to closing time that day (that day's
 *  own hours if set, else the usual ones, else the Member hours, else
 *  8 AM-8 PM), stretched to cover the party if it runs outside them. */
export function partyPassWindow(a: { startsAt: string; endsAt?: string | null; pool: unknown; memberLevel?: Level | null; tz: string }): { starts_at: string; ends_at: string } {
  const pool = (a.pool ?? {}) as Record<string, unknown>;
  const day = poolDate(a.startsAt, a.tz);
  const [y, m, d] = day.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const byDay = ((pool.hours_by_day ?? {}) as Record<string, { opens?: string | null; closes?: string | null; closed?: boolean } | null>)[String(dow)];
  const ok = (v: unknown) => typeof v === 'string' && TIME_RE.test(v.slice(0, 5)) ? v.slice(0, 5) : null;
  const opens = (!byDay?.closed && ok(byDay?.opens)) || ok(pool.opens_at) || a.memberLevel?.start || '08:00';
  const closes = (!byDay?.closed && ok(byDay?.closes)) || ok(pool.closes_at) || a.memberLevel?.end || '20:00';
  const at = (hhmm: string) => { const [h, mi] = hhmm.split(':').map(Number); return wallTimeToUtc(y, m, d, h, mi, 0, a.tz).getTime(); };
  const start = Math.min(at(opens), Date.parse(a.startsAt));
  const end = Math.max(at(closes), a.endsAt ? Date.parse(a.endsAt) : 0);
  return { starts_at: new Date(start).toISOString(), ends_at: new Date(end).toISOString() };
}

// ── The few that touch the database ─────────────────────────────────────
export async function loadAccess(sb: SupabaseClient, tenantId: string): Promise<{ config: AccessConfig; doorsRaw: unknown; bridgeVersion: string | null; settingsValue: Record<string, unknown>; tz: string }> {
  const [{ data: st }, { data: panel }, { data: tenant }] = await Promise.all([
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('gate_panels').select('doors, bridge_version').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('tenants').select('timezone').eq('id', tenantId).maybeSingle(),
  ]);
  const settingsValue = (st?.value ?? {}) as Record<string, unknown>;
  const doorsRaw = panel?.doors ?? [];
  return { config: accessConfig(settingsValue, doorsRaw), doorsRaw, bridgeVersion: (panel?.bridge_version as string | null) ?? null, settingsValue,
    tz: zoneOrDefault(tenant?.timezone as string | null | undefined) };
}

/** A paid party: its family gets the party doors that day. Once per party. */
export async function givePartyPass(sb: SupabaseClient, tenantId: string, partyId: string): Promise<boolean> {
  const { config, settingsValue, tz } = await loadAccess(sb, tenantId);
  if (!config.party_doors.length) return false;
  const { data: p } = await sb.from('party_bookings').select('id, title, household_id, starts_at, ends_at')
    .eq('id', partyId).eq('tenant_id', tenantId).maybeSingle();
  if (!p?.household_id || !p.starts_at) return false;
  const w = partyPassWindow({ startsAt: p.starts_at as string, endsAt: p.ends_at as string | null, pool: settingsValue.pool,
    memberLevel: config.levels.find(l => l.key === 'member') ?? null, tz });
  const { error } = await sb.from('access_passes').upsert({
    tenant_id: tenantId, household_id: p.household_id, doors: config.party_doors, starts_at: w.starts_at, ends_at: w.ends_at,
    note: `Party: ${String(p.title || 'party').slice(0, 80)}`, source_kind: 'party', source_id: p.id, ended_at: null,
  }, { onConflict: 'tenant_id,source_kind,source_id', ignoreDuplicates: false });
  return !error;
}

/** A canceled or rejected party loses its pass. */
export async function endPartyPass(sb: SupabaseClient, tenantId: string, partyId: string): Promise<void> {
  await sb.from('access_passes').update({ ended_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('source_kind', 'party').eq('source_id', partyId).is('ended_at', null);
}

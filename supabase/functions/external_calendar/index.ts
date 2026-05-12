// =============================================================================
// external_calendar — pull events from iCal/ICS feeds (Google, Swimtopia, etc.)
// =============================================================================
// One-way import: admin pastes a feed URL, we fetch it server-side, parse the
// iCal text, cache the events in DB, then merge them into the unified Poolside
// calendar view (admin + member). No OAuth — keeps the Google scope footprint
// clean (verification is in flight for Drive/Sheets only).
//
// Actions:
//   { action: 'list_feeds' }  → admin: list feeds for this tenant (full row)
//   { action: 'list_public', slug }  → member: list ENABLED feeds for a tenant
//                                      (no auth — used by member calendar render)
//   { action: 'add_feed', label, ical_url, color? }  → admin only
//   { action: 'update_feed', id, ...patch }          → admin only
//   { action: 'delete_feed', id }                    → admin only
//   { action: 'test_fetch', ical_url }               → admin: pre-save validation;
//                                                      returns next 5 events on success
//   { action: 'sync_feed', id }                      → admin: force a refetch
//   { action: 'sync_all', slug? } (internal)         → cron / on-demand refresh of
//                                                      ALL feeds in window [now-7d, now+90d]
//
// Cache strategy: cached_events stores the last successful parse (events within
// [now-7d, now+90d]). Render layer reads cached_events directly — no live fetch
// on page load. A small in-band refresh fires if the cache is >15 min old on
// list_public, but the response uses whatever was last cached (stale ok).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyTenantAdmin, requireOwner } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'content-type': 'application/json' },
  });
}

// ─── Minimal iCal parser ──────────────────────────────────────────────────
// Handles the subset that Google Calendar + Swimtopia actually emit:
//   • VEVENT blocks (SUMMARY, DESCRIPTION, DTSTART, DTEND, LOCATION, UID,
//     STATUS, URL)
//   • Line unfolding (RFC 5545: lines beginning with space/tab continue the
//     previous line)
//   • DTSTART/DTEND in either DATE form (YYYYMMDD) or DATETIME form
//     (YYYYMMDDTHHMMSSZ or YYYYMMDDTHHMMSS with TZID)
//   • Simple FREQ=WEEKLY and FREQ=MONTHLY RRULE expansion (BYDAY, BYMONTHDAY,
//     INTERVAL, COUNT, UNTIL)
//   • STATUS:CANCELLED → skip
//
// What we DON'T handle (call out in admin help text):
//   • Complex RRULE with BYSETPOS, BYYEARDAY, etc. — rare in pool-club world
//   • EXDATE exceptions — if a recurring event has an exclusion, we'll still
//     show the instance. Worst case: admin deletes the instance from source.
// ─────────────────────────────────────────────────────────────────────────

type ParsedEvent = {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  starts_at: string;        // ISO 8601 UTC
  ends_at?: string;
  all_day: boolean;
  source_url?: string;
};

function unfoldLines(text: string): string[] {
  // Per RFC 5545 §3.1: lines starting with " " or "\t" are continuations of
  // the previous line. Common in Google iCal output for long descriptions.
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

// Parse an iCal date/datetime string into an ISO 8601 UTC string.
// Examples:
//   "20260712"                  → "2026-07-12T00:00:00.000Z" (all-day; flag separately)
//   "20260712T143000Z"          → "2026-07-12T14:30:00.000Z"
//   "20260712T143000"           → "2026-07-12T14:30:00.000Z" (assume UTC if no TZID)
// TZID handling: full Olson DB conversion in Deno without a library is heavy.
// For MVP, treat TZID-tagged times as local-to-tenant (display will be in the
// browser's timezone anyway). If users see drift, we can add a tz library later.
function parseIcalDate(value: string, isDateOnly = false): { iso: string; all_day: boolean } | null {
  if (!value) return null;
  if (isDateOnly || /^\d{8}$/.test(value)) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, all_day: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return null;
  return { iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`, all_day: false };
}

// Split a property line: "DTSTART;TZID=America/Los_Angeles:20260712T143000"
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
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

// Expand a recurring event into individual instances within [windowStart, windowEnd].
// Handles FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY,
// BYMONTHDAY. Conservative — if RRULE has fields we don't handle, return just
// the base event so the admin still sees something.
function expandRrule(
  rrule: string,
  baseStart: Date,
  baseEnd: Date | null,
  windowStart: Date,
  windowEnd: Date,
): Array<{ start: Date; end: Date | null }> {
  const fields: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  }
  const freq = fields.FREQ;
  const interval = Math.max(1, parseInt(fields.INTERVAL || '1', 10));
  const count = fields.COUNT ? parseInt(fields.COUNT, 10) : null;
  const untilStr = fields.UNTIL;
  let until: Date | null = null;
  if (untilStr) {
    const parsed = parseIcalDate(untilStr);
    if (parsed) until = new Date(parsed.iso);
  }
  const duration = baseEnd ? baseEnd.getTime() - baseStart.getTime() : 0;
  const byday = (fields.BYDAY || '').split(',').filter(Boolean);
  const dayMap: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const targetDays = byday.map(d => dayMap[d.slice(-2).toUpperCase()]).filter(d => d !== undefined);

  const out: Array<{ start: Date; end: Date | null }> = [];
  let cur = new Date(baseStart);
  let safetyCounter = 0;
  while (cur.getTime() <= windowEnd.getTime() && safetyCounter < 500) {
    safetyCounter++;
    if (until && cur > until) break;
    if (count !== null && out.length >= count) break;
    if (cur.getTime() >= windowStart.getTime() - 86400_000) {
      // For WEEKLY+BYDAY, emit one instance per matching day of week in the
      // current week-interval. For other freqs, emit cur directly.
      if (freq === 'WEEKLY' && targetDays.length > 0) {
        // Find start of week (Sunday)
        const weekStart = new Date(cur);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        for (const d of targetDays) {
          const inst = new Date(weekStart);
          inst.setDate(weekStart.getDate() + d);
          inst.setHours(cur.getHours(), cur.getMinutes(), cur.getSeconds(), 0);
          if (inst.getTime() >= baseStart.getTime() && inst.getTime() <= windowEnd.getTime()) {
            if (!until || inst <= until) {
              if (count === null || out.length < count) {
                out.push({ start: inst, end: duration ? new Date(inst.getTime() + duration) : null });
              }
            }
          }
        }
      } else {
        out.push({ start: new Date(cur), end: duration ? new Date(cur.getTime() + duration) : null });
      }
    }
    // Advance cursor by interval
    switch (freq) {
      case 'DAILY':   cur.setDate(cur.getDate() + interval); break;
      case 'WEEKLY':  cur.setDate(cur.getDate() + 7 * interval); break;
      case 'MONTHLY': cur.setMonth(cur.getMonth() + interval); break;
      case 'YEARLY':  cur.setFullYear(cur.getFullYear() + interval); break;
      default: return out;  // unknown FREQ — bail
    }
  }
  return out;
}

function parseIcal(text: string, windowStart: Date, windowEnd: Date): ParsedEvent[] {
  const lines = unfoldLines(text);
  const events: ParsedEvent[] = [];
  let inEvent = false;
  let cur: Record<string, string> = {};
  let rrule: string | null = null;
  let dtstartParams: Record<string, string> = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true; cur = {}; rrule = null; dtstartParams = {};
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
      // Reject cancelled events
      if ((cur.STATUS || '').toUpperCase() === 'CANCELLED') continue;
      const isDateOnly = (dtstartParams.VALUE || '').toUpperCase() === 'DATE';
      const dtstart = parseIcalDate(cur.DTSTART, isDateOnly);
      if (!dtstart) continue;
      const dtend = cur.DTEND ? parseIcalDate(cur.DTEND, isDateOnly) : null;
      const baseStart = new Date(dtstart.iso);
      const baseEnd = dtend ? new Date(dtend.iso) : null;

      const buildEvent = (start: Date, end: Date | null): ParsedEvent => ({
        uid: cur.UID || `${cur.SUMMARY || 'event'}-${start.toISOString()}`,
        summary: unescapeIcal(cur.SUMMARY || '(untitled event)'),
        description: cur.DESCRIPTION ? unescapeIcal(cur.DESCRIPTION) : undefined,
        location: cur.LOCATION ? unescapeIcal(cur.LOCATION) : undefined,
        starts_at: start.toISOString(),
        ends_at: end ? end.toISOString() : undefined,
        all_day: dtstart.all_day,
        source_url: cur.URL || undefined,
      });

      if (rrule) {
        const instances = expandRrule(rrule, baseStart, baseEnd, windowStart, windowEnd);
        for (const inst of instances) events.push(buildEvent(inst.start, inst.end));
      } else {
        // Only include if it falls in the window
        if (baseStart.getTime() >= windowStart.getTime() && baseStart.getTime() <= windowEnd.getTime()) {
          events.push(buildEvent(baseStart, baseEnd));
        }
      }
      continue;
    }
    if (!inEvent) continue;
    const prop = splitProp(line);
    if (!prop) continue;
    if (prop.name === 'RRULE') rrule = prop.value;
    else if (prop.name === 'DTSTART') { cur.DTSTART = prop.value; dtstartParams = prop.params; }
    else cur[prop.name] = prop.value;
  }
  return events;
}

// ─── Fetch + cache helper ─────────────────────────────────────────────────
async function fetchAndParse(icalUrl: string): Promise<{ events: ParsedEvent[]; error?: string }> {
  try {
    const res = await fetch(icalUrl, {
      headers: { 'User-Agent': 'Poolside/1.0 (external-calendar-feed)' },
    });
    if (!res.ok) {
      return { events: [], error: `Fetch failed: ${res.status} ${res.statusText}` };
    }
    const text = await res.text();
    if (!text.includes('BEGIN:VCALENDAR')) {
      return { events: [], error: 'Response is not an iCal feed (no BEGIN:VCALENDAR marker)' };
    }
    const now = Date.now();
    const windowStart = new Date(now - 7 * 86400_000);
    const windowEnd   = new Date(now + 180 * 86400_000);    // 6 months forward
    const events = parseIcal(text, windowStart, windowEnd);
    // Sort by start
    events.sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return { events };
  } catch (e) {
    return { events: [], error: (e as Error).message };
  }
}

async function refreshFeed(sb: ReturnType<typeof createClient>, feedId: string): Promise<{ ok: boolean; events_count?: number; error?: string }> {
  const { data: feed } = await sb.from('external_calendar_feeds')
    .select('id, ical_url').eq('id', feedId).maybeSingle();
  if (!feed) return { ok: false, error: 'Feed not found' };
  const { events, error } = await fetchAndParse(feed.ical_url as string);
  if (error) {
    await sb.from('external_calendar_feeds').update({
      last_synced_at: new Date().toISOString(),
      last_error: error.slice(0, 500),
      updated_at: new Date().toISOString(),
    }).eq('id', feedId);
    return { ok: false, error };
  }
  await sb.from('external_calendar_feeds').update({
    cached_events: events,
    last_synced_at: new Date().toISOString(),
    last_error: null,
    updated_at: new Date().toISOString(),
  }).eq('id', feedId);
  return { ok: true, events_count: events.length };
}

// ─── HTTP handler ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ─ Public action: member-facing calendar render ─────────────────────────
  // No auth — anyone with the tenant slug can fetch the enabled feeds'
  // cached events. Doesn't expose iCal URLs (which may contain secret keys
  // for private Google calendars).
  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const { data: feeds } = await sb.from('external_calendar_feeds')
      .select('id, label, color, cached_events, last_synced_at')
      .eq('tenant_id', tenant.id).eq('enabled', true);
    return jsonResponse({
      ok: true,
      feeds: (feeds ?? []).map(f => ({
        id: f.id, label: f.label, color: f.color,
        last_synced_at: f.last_synced_at,
        events: f.cached_events ?? [],
      })),
    });
  }

  // ─ Admin-only actions below ─────────────────────────────────────────────
  const payload = await verifyTenantAdmin(req);
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  // Owner-only: external-calendar config is a club-config decision, same
  // bar as Stripe Connect / Drive Connect. Scoped admins shouldn't add feeds.
  if (!(await requireOwner(sb, payload as never))) {
    return jsonResponse({ ok: false, error: 'Only owners can manage external calendars' }, 403);
  }
  const TID = payload.tid;

  if (action === 'list_feeds') {
    const { data, error } = await sb.from('external_calendar_feeds')
      .select('id, label, ical_url, color, enabled, last_synced_at, last_error, cached_events, created_at')
      .eq('tenant_id', TID)
      .order('created_at', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Include events_count for UI, omit huge cached_events from list payload
    const feeds = (data ?? []).map(f => ({
      ...f,
      events_count: Array.isArray(f.cached_events) ? f.cached_events.length : 0,
      cached_events: undefined,
    }));
    return jsonResponse({ ok: true, feeds });
  }

  if (action === 'test_fetch') {
    const url = String(body.ical_url ?? '').trim();
    if (!url) return jsonResponse({ ok: false, error: 'ical_url required' }, 400);
    if (!/^https?:\/\//.test(url)) return jsonResponse({ ok: false, error: 'URL must start with http(s)://' }, 400);
    const { events, error } = await fetchAndParse(url);
    if (error) return jsonResponse({ ok: false, error });
    return jsonResponse({
      ok: true,
      events_count: events.length,
      preview: events.slice(0, 5).map(e => ({
        summary: e.summary,
        starts_at: e.starts_at,
        all_day: e.all_day,
      })),
    });
  }

  if (action === 'add_feed') {
    const label = String(body.label ?? '').trim();
    const ical_url = String(body.ical_url ?? '').trim();
    const color = String(body.color ?? '#0a3b5c').trim();
    if (!label) return jsonResponse({ ok: false, error: 'label required' }, 400);
    if (!ical_url) return jsonResponse({ ok: false, error: 'ical_url required' }, 400);
    if (!/^https?:\/\//.test(ical_url)) return jsonResponse({ ok: false, error: 'URL must start with http(s)://' }, 400);
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return jsonResponse({ ok: false, error: 'color must be a hex like #0a3b5c' }, 400);

    const { data: created, error } = await sb.from('external_calendar_feeds')
      .insert({ tenant_id: TID, label, ical_url, color, enabled: true })
      .select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Eager-fetch so the admin sees events immediately after adding
    const refresh = await refreshFeed(sb, created.id);
    return jsonResponse({ ok: true, id: created.id, refresh });
  }

  if (action === 'update_feed') {
    const id = String(body.id ?? '').trim();
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.label === 'string')    patch.label = body.label.trim();
    if (typeof body.color === 'string')    patch.color = body.color.trim();
    if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
    if (typeof body.ical_url === 'string') {
      patch.ical_url = body.ical_url.trim();
      patch.cached_events = null;       // bust cache when URL changes
      patch.last_synced_at = null;
      patch.last_error = null;
    }
    const { error } = await sb.from('external_calendar_feeds')
      .update(patch).eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // If URL changed, refresh now
    if (patch.ical_url) await refreshFeed(sb, id);
    return jsonResponse({ ok: true });
  }

  if (action === 'delete_feed') {
    const id = String(body.id ?? '').trim();
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('external_calendar_feeds')
      .delete().eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'sync_feed') {
    const id = String(body.id ?? '').trim();
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    // Verify ownership
    const { data: feed } = await sb.from('external_calendar_feeds')
      .select('id').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!feed) return jsonResponse({ ok: false, error: 'Feed not found' }, 404);
    const r = await refreshFeed(sb, id);
    return jsonResponse(r);
  }

  if (action === 'sync_all') {
    // Used by cron (internal) and admin "Refresh all" button. Refreshes every
    // enabled feed for the current tenant.
    const { data: feeds } = await sb.from('external_calendar_feeds')
      .select('id').eq('tenant_id', TID).eq('enabled', true);
    let ok = 0, failed = 0;
    for (const f of (feeds ?? [])) {
      const r = await refreshFeed(sb, f.id as string);
      if (r.ok) ok++; else failed++;
    }
    return jsonResponse({ ok: true, refreshed: ok, failed });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

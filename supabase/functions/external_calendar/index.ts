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
    // Anchor all-day events at noon UTC so the date is stable in every US
    // timezone. T00:00:00.000Z would shift to the previous day for any
    // observer west of UTC (most of the US), so May 15 would render as
    // May 14 5pm Pacific. Noon UTC = May 15 4-7am US-time → same calendar day.
    return { iso: `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`, all_day: true };
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
// BYMONTHDAY, and BYSETPOS for monthly patterns ("third Tuesday", "last Friday").
// EXDATE exclusions are handled by the caller (parseIcal) since they live on
// the VEVENT, not the RRULE.
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
  const bySetPos = (fields.BYSETPOS || '').split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n));

  const out: Array<{ start: Date; end: Date | null }> = [];
  let cur = new Date(baseStart);
  let safetyCounter = 0;

  // Helper: build an instance Date with cur's clock time (hours/minutes/seconds)
  // but a fresh day. Used by the BYDAY/BYSETPOS expansion below.
  const withTimeOf = (target: Date, ref: Date): Date => {
    const d = new Date(target);
    d.setHours(ref.getHours(), ref.getMinutes(), ref.getSeconds(), 0);
    return d;
  };

  while (cur.getTime() <= windowEnd.getTime() && safetyCounter < 500) {
    safetyCounter++;
    if (until && cur > until) break;
    if (count !== null && out.length >= count) break;

    if (cur.getTime() >= windowStart.getTime() - 86400_000) {
      if (freq === 'WEEKLY' && targetDays.length > 0) {
        // WEEKLY+BYDAY: emit each matching day of THIS week.
        const weekStart = new Date(cur);
        weekStart.setDate(weekStart.getDate() - weekStart.getDay());
        for (const d of targetDays) {
          const inst = new Date(weekStart);
          inst.setDate(weekStart.getDate() + d);
          const i2 = withTimeOf(inst, cur);
          if (i2.getTime() >= baseStart.getTime() && i2.getTime() <= windowEnd.getTime()) {
            if (!until || i2 <= until) {
              if (count === null || out.length < count) {
                out.push({ start: i2, end: duration ? new Date(i2.getTime() + duration) : null });
              }
            }
          }
        }
      } else if (freq === 'MONTHLY' && targetDays.length > 0) {
        // MONTHLY+BYDAY (+optional BYSETPOS): find every matching day in
        // this month, then pick the BYSETPOS-th one (1-indexed, or -1 for
        // last). Default (no BYSETPOS) emits all matching days.
        const year = cur.getFullYear();
        const month = cur.getMonth();
        const matches: Date[] = [];
        for (let day = 1; day <= 31; day++) {
          const d = new Date(year, month, day);
          if (d.getMonth() !== month) break;  // overflowed
          if (targetDays.includes(d.getDay())) matches.push(d);
        }
        let picked: Date[] = matches;
        if (bySetPos.length > 0) {
          picked = bySetPos
            .map(p => p > 0 ? matches[p - 1] : matches[matches.length + p])
            .filter((d): d is Date => d instanceof Date);
        }
        for (const inst of picked) {
          const i2 = withTimeOf(inst, cur);
          if (i2.getTime() >= baseStart.getTime() && i2.getTime() <= windowEnd.getTime()) {
            if (!until || i2 <= until) {
              if (count === null || out.length < count) {
                out.push({ start: i2, end: duration ? new Date(i2.getTime() + duration) : null });
              }
            }
          }
        }
      } else {
        out.push({ start: new Date(cur), end: duration ? new Date(cur.getTime() + duration) : null });
      }
    }
    switch (freq) {
      case 'DAILY':   cur.setDate(cur.getDate() + interval); break;
      case 'WEEKLY':  cur.setDate(cur.getDate() + 7 * interval); break;
      case 'MONTHLY': cur.setMonth(cur.getMonth() + interval); break;
      case 'YEARLY':  cur.setFullYear(cur.getFullYear() + interval); break;
      default: return out;
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
  // Collect EXDATE values per VEVENT — these are individual instances that
  // were explicitly cancelled from a recurring series (e.g. "every Friday
  // except July 4th"). Stored as a Set of YYYY-MM-DD UTC dates for cheap
  // membership testing against expanded instances.
  let exDates: Set<string> = new Set();

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      inEvent = true; cur = {}; rrule = null; dtstartParams = {}; exDates = new Set();
      continue;
    }
    if (line === 'END:VEVENT') {
      inEvent = false;
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
        for (const inst of instances) {
          // Skip instances explicitly excluded via EXDATE
          if (exDates.has(inst.start.toISOString().slice(0, 10))) continue;
          events.push(buildEvent(inst.start, inst.end));
        }
      } else {
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
    else if (prop.name === 'EXDATE') {
      // EXDATE can be a comma-separated list. Each entry parsed same as DTSTART.
      const isDateOnly = (prop.params.VALUE || '').toUpperCase() === 'DATE';
      for (const v of prop.value.split(',')) {
        const parsed = parseIcalDate(v.trim(), isDateOnly);
        if (parsed) exDates.add(parsed.iso.slice(0, 10));
      }
    }
    else cur[prop.name] = prop.value;
  }
  return events;
}

// ─── Fetch + cache helper ─────────────────────────────────────────────────
async function fetchAndParse(icalUrl: string): Promise<{ events: ParsedEvent[]; error?: string }> {
  try {
    // 10s ceiling — Google iCal usually responds in <1s but occasionally
    // stalls. Don't let one slow feed hang the whole function.
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(icalUrl, {
      headers: { 'User-Agent': 'Poolside/1.0 (external-calendar-feed)' },
      signal: ctrl.signal,
    }).finally(() => clearTimeout(timeout));
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
    .select('id, tenant_id, label, ical_url, consecutive_failures, last_alert_sent_at')
    .eq('id', feedId).maybeSingle();
  if (!feed) return { ok: false, error: 'Feed not found' };
  const { events, error } = await fetchAndParse(feed.ical_url as string);
  if (error) {
    const newFailures = ((feed.consecutive_failures as number | null) ?? 0) + 1;
    await sb.from('external_calendar_feeds').update({
      last_synced_at: new Date().toISOString(),
      last_error: error.slice(0, 500),
      consecutive_failures: newFailures,
      updated_at: new Date().toISOString(),
    }).eq('id', feedId);
    // Alert the admins once when failures hit 3 — and not more than once
    // per 24h after that, to avoid spamming if the feed stays broken.
    if (newFailures >= 3) {
      const lastAlert = feed.last_alert_sent_at ? new Date(feed.last_alert_sent_at as string).getTime() : 0;
      if (Date.now() - lastAlert > 86400_000) {
        await sendFeedFailureAlert(sb, feed.tenant_id as string, feed.label as string, feed.ical_url as string, error, newFailures);
        await sb.from('external_calendar_feeds').update({
          last_alert_sent_at: new Date().toISOString(),
        }).eq('id', feedId);
      }
    }
    return { ok: false, error };
  }
  await sb.from('external_calendar_feeds').update({
    cached_events: events,
    last_synced_at: new Date().toISOString(),
    last_error: null,
    consecutive_failures: 0,
    updated_at: new Date().toISOString(),
  }).eq('id', feedId);
  return { ok: true, events_count: events.length };
}

// Notify owner admins when a feed has failed 3+ times in a row. Plain-English
// — Linda doesn't know what "iCal" or "HTTP 401" means, so we translate.
async function sendFeedFailureAlert(
  sb: ReturnType<typeof createClient>,
  tenantId: string,
  label: string,
  icalUrl: string,
  error: string,
  failures: number,
): Promise<void> {
  try {
    const [{ data: tenant }, { data: owners }] = await Promise.all([
      sb.from('tenants').select('display_name, slug').eq('id', tenantId).maybeSingle(),
      sb.from('admin_users').select('email').eq('tenant_id', tenantId).eq('active', true)
        .or('role_template.eq.owner,is_super.eq.true'),
    ]);
    if (!tenant || !owners || !owners.length) return;
    const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
    const clubName = (tenant.display_name as string) || 'Your club';
    const slug = tenant.slug as string;
    // Plain-English translation of the most common failures
    let plainEnglish = 'We couldn\'t reach the calendar.';
    if (/404|not found/i.test(error)) plainEnglish = 'The URL doesn\'t exist anymore — the source calendar may have been deleted or its share link reset.';
    else if (/401|403|unauthorized|forbidden/i.test(error)) plainEnglish = 'The calendar URL is no longer accessible — most likely the source was changed from public to private (or the secret URL was rotated).';
    else if (/timeout|abort|aborted/i.test(error)) plainEnglish = 'The calendar source kept timing out. It might be temporarily down.';
    else if (/dns|name|resolve/i.test(error)) plainEnglish = 'We couldn\'t look up the calendar host. Check the URL for typos.';
    const html = `
      <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px;color:#0f172a">
        <h2 style="font-family:Georgia,serif;color:#7c2d12;margin:0 0 8px">⚠ Calendar feed failed ${failures} times</h2>
        <p style="margin:0 0 12px;line-height:1.55">Hi — the <b>${escHtml(label)}</b> calendar at <b>${escHtml(clubName)}</b> hasn't loaded successfully in a while.</p>
        <div style="margin:14px 0;padding:14px 16px;background:#fef3c7;border-radius:10px;font-size:13px;color:#78350f;line-height:1.55">
          <b>What's going on:</b> ${escHtml(plainEnglish)}<br>
          <b>Technical detail:</b> <code style="font-size:12px">${escHtml(error)}</code>
        </div>
        <p style="margin:0 0 12px;line-height:1.55">Members won't see any new events from <b>${escHtml(label)}</b> until this is fixed.</p>
        <p style="margin:18px 0">
          <a href="https://${escHtml(slug)}.poolsideapp.com/club/admin/events.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Fix in admin →</a>
        </p>
        <p style="margin:0;color:#64748b;font-size:12px">We'll keep trying every 15 minutes. We won't email you again about this calendar for 24 hours.</p>
      </div>
    `;
    for (const o of owners) {
      if (o.email) await sendEmail({ to: o.email as string, subject: `Calendar feed broken — ${label}`, html });
    }
  } catch { /* never fatal */ }
}

// ─── HTTP handler ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ─ Cron action: refresh ALL enabled feeds across ALL tenants ───────────
  // Called by pg_cron every 15 min (see migration 20260512000100). Gated by
  // x-cron-secret header (same secret as payment_plans cron, in Supabase
  // Vault as 'cron_secret').
  if (action === 'cron_sync_all') {
    const cronSecret = Deno.env.get('CRON_SECRET');
    const headerSecret = req.headers.get('x-cron-secret') || '';
    if (!cronSecret || headerSecret !== cronSecret) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }
    const { data: feeds } = await sb.from('external_calendar_feeds')
      .select('id').eq('enabled', true);
    let ok = 0, failed = 0;
    for (const f of (feeds ?? [])) {
      const r = await refreshFeed(sb, f.id as string);
      if (r.ok) ok++; else failed++;
    }
    return jsonResponse({ ok: true, refreshed: ok, failed });
  }

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

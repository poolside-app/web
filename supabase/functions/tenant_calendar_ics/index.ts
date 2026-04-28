// =============================================================================
// tenant_calendar_ics — Public iCal feed for a tenant's events
// =============================================================================
// No-auth GET. Returns an RFC-5545 ics file so members can subscribe to
// their club's calendar in Apple Calendar, Google Calendar, Outlook, etc.
//
// URL: <fn>?slug=<slug>
// Returns: text/calendar; charset=utf-8
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

// 2 MB cap on a feed — we'd hit other limits long before. Default 200 events.
const MAX_EVENTS = 200;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

// ICS escaping: backslash, comma, semicolon, newline.
function icsEscape(s: string): string {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

// Format a Date as ICS date-time (UTC). YYYYMMDDTHHmmssZ
function fmtIcsDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}` +
         `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
// Format a Date as an ICS DATE (YYYYMMDD) for all-day events
function fmtIcsDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}`;
}

// Fold long lines per RFC 5545 — limit 75 octets, continuation lines start
// with a single space. Keeps cross-client compatibility (Outlook is strict).
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + (i === 0 ? 75 : 74));
    parts.push(i === 0 ? chunk : ' ' + chunk);
    i += chunk.length - (i === 0 ? 0 : 1);
    if (i === 0) i += chunk.length;
  }
  return parts.join('\r\n');
}

const KIND_LABEL: Record<string, string> = {
  event: 'Event', party: 'Party', swim_meet: 'Swim meet', social: 'Social',
  closure: 'Closure', holiday: 'Holiday', lesson: 'Lesson', meeting: 'Meeting',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  const url = new URL(req.url);
  const slug = (url.searchParams.get('slug') || '').trim().toLowerCase();
  if (!slug) {
    return new Response('slug query param required', { status: 400, headers: cors });
  }

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { data: tenant } = await sb.from('tenants')
    .select('id, slug, display_name, status')
    .eq('slug', slug).maybeSingle();
  if (!tenant) return new Response('Not found', { status: 404, headers: cors });
  if (tenant.status === 'churned') {
    return new Response('Calendar is no longer available', { status: 410, headers: cors });
  }

  // Active events — past 90 days through next 2 years, cap at MAX_EVENTS.
  const since = new Date(Date.now() - 90 * 86400_000).toISOString();
  const until = new Date(Date.now() + 730 * 86400_000).toISOString();
  const { data: events } = await sb.from('events')
    .select('id, title, body, kind, location, starts_at, ends_at, all_day, updated_at, created_at')
    .eq('tenant_id', tenant.id)
    .eq('active', true)
    .gte('starts_at', since)
    .lte('starts_at', until)
    .order('starts_at', { ascending: true })
    .limit(MAX_EVENTS);

  const lines: string[] = [];
  lines.push('BEGIN:VCALENDAR');
  lines.push('VERSION:2.0');
  lines.push('PRODID:-//Poolside//' + icsEscape(tenant.display_name) + '//EN');
  lines.push('CALSCALE:GREGORIAN');
  lines.push('METHOD:PUBLISH');
  lines.push('X-WR-CALNAME:' + icsEscape(tenant.display_name));
  lines.push('X-WR-TIMEZONE:UTC');
  lines.push('X-WR-CALDESC:' + icsEscape(`${tenant.display_name} events on Poolside`));

  for (const ev of (events ?? [])) {
    const start = new Date(ev.starts_at as string);
    const end   = ev.ends_at ? new Date(ev.ends_at as string) : null;
    const stamp = new Date(ev.updated_at as string ?? ev.created_at as string ?? Date.now());
    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + ev.id + '@poolsideapp.com');
    lines.push('DTSTAMP:' + fmtIcsDateTime(stamp));
    if (ev.all_day) {
      lines.push('DTSTART;VALUE=DATE:' + fmtIcsDate(start));
      // For all-day, ICS uses an exclusive end-date one day after the last day.
      const e = end ?? new Date(start.getTime() + 86400_000);
      const eExclusive = new Date(e.getTime() + (end ? 86400_000 : 0));
      lines.push('DTEND;VALUE=DATE:' + fmtIcsDate(eExclusive));
    } else {
      lines.push('DTSTART:' + fmtIcsDateTime(start));
      if (end) lines.push('DTEND:' + fmtIcsDateTime(end));
    }
    const summaryLabel = (KIND_LABEL[ev.kind as string] && ev.kind !== 'event')
      ? `[${KIND_LABEL[ev.kind as string]}] ` : '';
    lines.push(foldLine('SUMMARY:' + icsEscape(summaryLabel + (ev.title as string))));
    if (ev.location) lines.push(foldLine('LOCATION:' + icsEscape(ev.location as string)));
    if (ev.body)     lines.push(foldLine('DESCRIPTION:' + icsEscape(ev.body as string)));
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  const body = lines.join('\r\n') + '\r\n';
  return new Response(body, {
    status: 200,
    headers: {
      ...cors,
      'content-type': 'text/calendar; charset=utf-8',
      // 5-minute browser cache; calendar clients refresh on their own schedule.
      'cache-control': 'public, max-age=300',
      'content-disposition': `inline; filename="${slug}.ics"`,
    },
  });
});

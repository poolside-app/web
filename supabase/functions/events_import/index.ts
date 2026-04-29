// =============================================================================
// events_import — Subscribe to + refresh ICS calendar feeds
// =============================================================================
// Auth: tenant admin token. Imported events are stored in events with
// source_url + source_uid so a refresh is idempotent (upsert by uid) and
// we can wipe a subscription cleanly without touching native events.
//
// Subscription metadata lives in settings.value.calendar_imports as an
// array of { url, name, color?, last_synced_at }.
//
// Actions:
//   { action: 'list' }                       → { ok, subscriptions: [...] }
//   { action: 'preview', source: 'url'|'ics', url?, ics? }
//                                             → { ok, sample, total_events,
//                                                  skipped_recurring }
//   { action: 'import', url, name?, color? } → { ok, summary }
//   { action: 'refresh', url }               → { ok, summary }
//   { action: 'remove', url, delete_events?: bool }
//                                             → { ok }
//
// v1 limitations:
//   • RRULE expansion not supported — imports skip recurring events and
//     reports the count back so admins know.
//   • Naive datetimes treated as UTC. TZID parsing deferred.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

type Payload = { sub: string; kind: string; tid: string; synthetic?: boolean };
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin' || !payload.sub || !payload.tid) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

// ── ICS parser ──────────────────────────────────────────────────────────

type ParsedEvent = {
  uid: string;
  summary: string;
  description: string | null;
  location: string | null;
  starts_at: string;       // ISO
  ends_at: string | null;  // ISO
  all_day: boolean;
};

// Unfold (per RFC 5545: continuation lines start with whitespace)
function unfold(raw: string): string[] {
  const cleaned = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out: string[] = [];
  for (const line of cleaned.split('\n')) {
    if (/^[ \t]/.test(line) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else {
      out.push(line);
    }
  }
  return out;
}

function unescapeText(s: string): string {
  return s
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Parse a property line "NAME;PARAMS:VALUE" → { name, params, value }
function parseProp(line: string) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts[0].toUpperCase();
  const params: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
  }
  return { name, params, value };
}

// Convert ICS DATE-TIME ("20260615T140000" or "20260615T140000Z") → ISO
function icsToIso(value: string, params: Record<string, string>): { iso: string; allDay: boolean } | null {
  const allDay = (params.VALUE === 'DATE') || /^\d{8}$/.test(value);
  if (allDay) {
    const m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (!m) return null;
    return { iso: `${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`, allDay: true };
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  // Naive (no Z) treated as UTC for v1; TZID handling deferred.
  return { iso: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`, allDay: false };
}

function parseIcs(raw: string): { events: ParsedEvent[]; skipped_recurring: number } {
  const lines = unfold(raw);
  const events: ParsedEvent[] = [];
  let skipped_recurring = 0;
  let inEvent = false;
  let cur: Partial<ParsedEvent> & { hasRrule?: boolean } = {};

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { inEvent = true; cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur.hasRrule) {
        skipped_recurring++;
      } else if (cur.uid && cur.summary && cur.starts_at) {
        events.push({
          uid: cur.uid,
          summary: cur.summary,
          description: cur.description ?? null,
          location: cur.location ?? null,
          starts_at: cur.starts_at,
          ends_at: cur.ends_at ?? null,
          all_day: !!cur.all_day,
        });
      }
      inEvent = false;
      cur = {};
      continue;
    }
    if (!inEvent) continue;
    const p = parseProp(line);
    if (!p) continue;
    switch (p.name) {
      case 'UID':         cur.uid = p.value; break;
      case 'SUMMARY':     cur.summary = unescapeText(p.value); break;
      case 'DESCRIPTION': cur.description = unescapeText(p.value); break;
      case 'LOCATION':    cur.location = unescapeText(p.value); break;
      case 'DTSTART': {
        const r = icsToIso(p.value, p.params);
        if (r) { cur.starts_at = r.iso; cur.all_day = r.allDay; }
        break;
      }
      case 'DTEND': {
        const r = icsToIso(p.value, p.params);
        if (r) cur.ends_at = r.iso;
        break;
      }
      case 'RRULE': cur.hasRrule = true; break;
    }
  }
  return { events, skipped_recurring };
}

async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  const text = await res.text();
  if (!text.includes('BEGIN:VCALENDAR')) {
    throw new Error('Response is not an ICS calendar feed');
  }
  return text;
}

function inferKind(summary: string): string {
  const s = summary.toLowerCase();
  if (/swim\s*meet|dual\s*meet|invitational|championship/i.test(s)) return 'swim_meet';
  if (/closed|closure/i.test(s)) return 'closure';
  if (/holiday/i.test(s)) return 'holiday';
  if (/lesson|swim\s*lesson|practice/i.test(s)) return 'lesson';
  if (/meeting|board/i.test(s)) return 'meeting';
  if (/party|bbq|cookout|social|potluck/i.test(s)) return 'social';
  return 'event';
}

async function applyImport(
  sb: ReturnType<typeof createClient>,
  tenant_id: string,
  url: string,
  parsed: ParsedEvent[],
): Promise<{ added: number; updated: number; removed: number; skipped: number }> {
  // Pull existing imported events for this URL so we can diff
  const { data: existing } = await sb.from('events')
    .select('id, source_uid')
    .eq('tenant_id', tenant_id).eq('source_url', url);
  const existingByUid = new Map((existing ?? []).map(e => [e.source_uid as string, e.id as string]));
  const seenUids = new Set<string>();

  let added = 0, updated = 0, skipped = 0;
  const nowIso = new Date().toISOString();

  for (const ev of parsed) {
    if (!ev.uid || !ev.starts_at) { skipped++; continue; }
    seenUids.add(ev.uid);
    const row = {
      tenant_id,
      title: ev.summary.slice(0, 140) || '(no title)',
      body:  ev.description?.slice(0, 4000) ?? null,
      kind: inferKind(ev.summary),
      location: ev.location?.slice(0, 200) ?? null,
      starts_at: ev.starts_at,
      ends_at: ev.ends_at,
      all_day: ev.all_day,
      active: true,
      source_url: url,
      source_uid: ev.uid,
      imported_at: nowIso,
      updated_at: nowIso,
    };
    const existingId = existingByUid.get(ev.uid);
    if (existingId) {
      const { error } = await sb.from('events').update(row).eq('id', existingId);
      if (!error) updated++;
    } else {
      const { error } = await sb.from('events').insert(row);
      if (!error) added++;
    }
  }

  // Anything that vanished from the feed gets removed (active=false so
  // it falls out of every visible surface but we keep audit history)
  let removed = 0;
  for (const [uid, id] of existingByUid) {
    if (!seenUids.has(uid)) {
      const { error } = await sb.from('events').update({
        active: false, updated_at: nowIso,
      }).eq('id', id);
      if (!error) removed++;
    }
  }

  return { added, updated, removed, skipped };
}

async function readSubs(sb: ReturnType<typeof createClient>, tenant_id: string) {
  const { data } = await sb.from('settings')
    .select('value').eq('tenant_id', tenant_id).maybeSingle();
  const v = (data?.value ?? {}) as Record<string, unknown>;
  const arr = Array.isArray(v.calendar_imports) ? v.calendar_imports as Array<Record<string, unknown>> : [];
  return { value: v, subs: arr };
}

async function writeSubs(sb: ReturnType<typeof createClient>, tenant_id: string, value: Record<string, unknown>, subs: Array<Record<string, unknown>>) {
  const next = { ...value, calendar_imports: subs };
  const { data: existing } = await sb.from('settings')
    .select('tenant_id').eq('tenant_id', tenant_id).maybeSingle();
  if (existing) await sb.from('settings').update({ value: next }).eq('tenant_id', tenant_id);
  else await sb.from('settings').insert({ tenant_id, value: next });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    const { subs } = await readSubs(sb, TID);
    return jsonResponse({ ok: true, subscriptions: subs });
  }

  if (action === 'preview') {
    const source = String(body.source ?? 'url');
    let raw: string;
    try {
      if (source === 'url') {
        const url = String(body.url ?? '').trim();
        if (!/^https?:\/\//i.test(url)) return jsonResponse({ ok: false, error: 'A http(s) URL is required' }, 400);
        raw = await fetchIcs(url);
      } else {
        raw = String(body.ics ?? '');
        if (!raw.includes('BEGIN:VCALENDAR')) return jsonResponse({ ok: false, error: 'Not a valid ICS payload' }, 400);
      }
    } catch (e) { return jsonResponse({ ok: false, error: (e as Error).message }, 400); }

    const { events, skipped_recurring } = parseIcs(raw);
    return jsonResponse({
      ok: true,
      total_events: events.length,
      skipped_recurring,
      sample: events.slice(0, 5).map(e => ({
        title: e.summary, starts_at: e.starts_at, ends_at: e.ends_at,
        location: e.location, all_day: e.all_day, kind: inferKind(e.summary),
      })),
    });
  }

  if (action === 'import' || action === 'refresh') {
    const url = String(body.url ?? '').trim();
    if (!/^https?:\/\//i.test(url)) return jsonResponse({ ok: false, error: 'A http(s) URL is required' }, 400);
    let raw: string;
    try { raw = await fetchIcs(url); }
    catch (e) { return jsonResponse({ ok: false, error: (e as Error).message }, 400); }

    const { events, skipped_recurring } = parseIcs(raw);
    const summary = await applyImport(sb, TID, url, events);

    // Update / insert the subscription record in settings
    const { value, subs } = await readSubs(sb, TID);
    const i = subs.findIndex(s => s.url === url);
    const nowIso = new Date().toISOString();
    const meta = {
      url,
      name: String(body.name ?? subs[i]?.name ?? new URL(url).hostname),
      color: body.color ?? subs[i]?.color ?? null,
      last_synced_at: nowIso,
      last_summary: { ...summary, skipped_recurring },
    };
    if (i >= 0) subs[i] = meta; else subs.push(meta);
    await writeSubs(sb, TID, value, subs);

    return jsonResponse({ ok: true, summary: { ...summary, skipped_recurring }, subscription: meta });
  }

  if (action === 'remove') {
    const url = String(body.url ?? '').trim();
    if (!url) return jsonResponse({ ok: false, error: 'url required' }, 400);
    const deleteEvents = body.delete_events !== false;  // default true

    if (deleteEvents) {
      // Soft-delete imported events from this feed only (active=false)
      await sb.from('events').update({
        active: false, updated_at: new Date().toISOString(),
      }).eq('tenant_id', TID).eq('source_url', url);
    }
    const { value, subs } = await readSubs(sb, TID);
    const next = subs.filter(s => s.url !== url);
    await writeSubs(sb, TID, value, next);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

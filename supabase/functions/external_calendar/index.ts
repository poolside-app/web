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
// Parsing lives in _shared/ical.ts (time-zone aware; tested by scripts/test_pool_time.mjs).
import { parseIcal, type ParsedEvent } from '../_shared/ical.ts';
import { tenantTimeZone, DEFAULT_TZ } from '../_shared/pool_time.ts';

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

// ─── Fetch + cache helper ─────────────────────────────────────────────────
async function fetchAndParse(icalUrl: string, poolTz: string = DEFAULT_TZ): Promise<{ events: ParsedEvent[]; error?: string }> {
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
    const events = parseIcal(text, windowStart, windowEnd, poolTz);
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
  const { events, error } = await fetchAndParse(feed.ical_url as string, await tenantTimeZone(sb, feed.tenant_id as string));
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
    const { events, error } = await fetchAndParse(url, await tenantTimeZone(sb, TID));
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

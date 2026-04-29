// =============================================================================
// tenant_metrics — Aggregate "time saved by Poolside" stats per tenant
// =============================================================================
// Auth: tenant admin token. Pure aggregation over existing tables — no new
// schema. Returns hours saved, dollar value, and a category breakdown so
// the admin Impact page (and future dashboard banners) can render it.
//
// Time estimates are tunable; ship with reasonable defaults that we can
// revise as we learn. Each unit of work has a per-row minute cost a
// volunteer would have paid manually.
//
// Action:
//   { action: 'get' }
//     → { ok, totals, categories, since, hourly_rate }
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

type Payload = { sub: string; kind: string; tid: string };
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

// Per-row minute estimates — what a volunteer doing this manually would burn.
const MIN_PER_HOUSEHOLD_MEMBER  =  5; // directory entry / update
const MIN_PER_NATIVE_EVENT      =  4; // creating a calendar entry by hand
const MIN_PER_IMPORTED_EVENT    =  2; // bulk-imported, but still saves the bulk-entry tax
const MIN_PER_POST              = 15; // compose + email blast manually
const MIN_PER_PHOTO             =  5; // curation + newsletter inclusion
const MIN_PER_APPROVED_PARTY    = 25; // 20m phone tag + 5m confirmation email
const MIN_PER_MEMBER_SIGN_IN    =  2; // password help / lookup avoided
const MIN_PER_CALENDAR_REFRESH  = 30; // bulk swim-team / external schedule reentry

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
  if (action !== 'get') return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Tenant since-date so the page can say "since opening day"
  const { data: tenant } = await sb.from('tenants')
    .select('created_at').eq('id', TID).maybeSingle();

  // Hourly rate from settings (defaults to $25)
  const { data: settings } = await sb.from('settings')
    .select('value').eq('tenant_id', TID).maybeSingle();
  const hourly_rate = Number((settings?.value as Record<string, unknown> | null)?.value_per_hour) || 25;

  // ── Counts in parallel ─────────────────────────────────────────────────
  const [
    { count: members },
    { count: nativeEvents },
    { count: importedEvents },
    { count: posts },
    { count: photos },
    { count: approvedParties },
    { count: memberSignIns },
    { data: importSubs },
  ] = await Promise.all([
    sb.from('household_members').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('active', true),
    sb.from('events').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('active', true).is('source_url', null),
    sb.from('events').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('active', true).not('source_url', 'is', null),
    sb.from('posts').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('active', true),
    sb.from('photos').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('active', true),
    sb.from('party_bookings').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('status', 'approved'),
    sb.from('member_magic_links').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).not('used_at', 'is', null),
    sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle().then(r => {
      const v = (r.data?.value as Record<string, unknown> | undefined)?.calendar_imports;
      return { data: Array.isArray(v) ? v : [] };
    }),
  ]);

  const importRefreshCount = (importSubs ?? []).length; // each subscription = 1 saved bulk entry

  const rows = [
    { key: 'members',     label: 'Member directory',          count: members ?? 0,         minPerRow: MIN_PER_HOUSEHOLD_MEMBER, why: 'kept current automatically' },
    { key: 'events',      label: 'Calendar events',           count: nativeEvents ?? 0,    minPerRow: MIN_PER_NATIVE_EVENT,     why: 'self-service entry vs. board secretary' },
    { key: 'imported',    label: 'Imported events',           count: importedEvents ?? 0,  minPerRow: MIN_PER_IMPORTED_EVENT,   why: 'pulled from external feeds, no re-entry' },
    { key: 'subs',        label: 'Calendar subscriptions',    count: importRefreshCount,   minPerRow: MIN_PER_CALENDAR_REFRESH, why: 'bulk-imported in one click' },
    { key: 'posts',       label: 'Announcements',             count: posts ?? 0,           minPerRow: MIN_PER_POST,             why: 'one post replaces an email blast' },
    { key: 'photos',      label: 'Photos shared',             count: photos ?? 0,          minPerRow: MIN_PER_PHOTO,            why: 'no newsletter assembly' },
    { key: 'parties',     label: 'Parties booked & approved', count: approvedParties ?? 0, minPerRow: MIN_PER_APPROVED_PARTY,   why: 'request → approve → on the calendar' },
    { key: 'sign_ins',    label: 'Passwordless sign-ins',     count: memberSignIns ?? 0,   minPerRow: MIN_PER_MEMBER_SIGN_IN,   why: 'no password resets to chase' },
  ].map(r => ({ ...r, minutes: r.count * r.minPerRow }));

  const totalMinutes = rows.reduce((s, r) => s + r.minutes, 0);
  const totalHours   = totalMinutes / 60;
  const totalDollars = (totalHours * hourly_rate);

  return jsonResponse({
    ok: true,
    totals: {
      minutes: totalMinutes,
      hours:   Math.round(totalHours * 10) / 10,
      dollars: Math.round(totalDollars),
    },
    categories: rows,
    since: tenant?.created_at ?? null,
    hourly_rate,
  });
});

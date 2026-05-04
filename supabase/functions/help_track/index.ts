// =============================================================================
// help_track — record an admin help-center event for product analytics
// =============================================================================
// Single-event-per-request. Auth via tenant_admin JWT so tenant_id and
// admin_user_id derive from the token (never trusted from the body).
//
// Events: search | no_results | article_view | article_close
//       | support_email_clicked | fab_clicked
//
// Returns 204 No Content on success. Failure is silent on the client side
// (analytics should never break the user-facing flow).
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyTenantAdmin } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ALLOWED_EVENTS = new Set([
  'search', 'no_results', 'article_view', 'article_close',
  'support_email_clicked', 'fab_clicked',
]);

// Strip a User-Agent string down to ~"Chrome 120 / macOS" granularity. We
// only care about device class for product decisions; we don't need or want
// the full UA fingerprint for analytics.
function summarizeUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const s = String(ua).slice(0, 500);
  const browserMatch =
    s.match(/Edg\/([\d.]+)/) ||
    s.match(/Chrome\/([\d.]+)/) ||
    s.match(/Firefox\/([\d.]+)/) ||
    s.match(/Safari\/([\d.]+)/);
  const osMatch =
    /Windows NT/.test(s) ? 'Windows' :
    /Mac OS X/.test(s)   ? 'macOS' :
    /iPhone|iPad/.test(s) ? 'iOS' :
    /Android/.test(s)    ? 'Android' :
    /Linux/.test(s)      ? 'Linux' : null;
  const browser = browserMatch
    ? `${browserMatch[0].split('/')[0]} ${browserMatch[1].split('.')[0]}`
    : 'unknown';
  return `${browser}${osMatch ? ' / ' + osMatch : ''}`.slice(0, 100);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST')    return new Response('POST required', { status: 405, headers: cors });

  const payload = await verifyTenantAdmin(req);
  if (!payload) return new Response('unauth', { status: 401, headers: cors });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }

  const eventType = String(body.event_type ?? '').trim();
  if (!ALLOWED_EVENTS.has(eventType)) {
    return new Response('bad event_type', { status: 400, headers: cors });
  }

  // Sanitize each field. Hard caps are deliberate — long values mean a bug
  // or an attempt to log PII; we'd rather truncate than store either.
  const query        = body.query ? String(body.query).slice(0, 200) : null;
  const articleSlug  = body.article_slug ? String(body.article_slug).slice(0, 80) : null;
  const durationMs   = Number.isFinite(Number(body.duration_ms)) ? Math.min(86400000, Math.max(0, Number(body.duration_ms))) : null;
  const resultsCount = Number.isFinite(Number(body.results_count)) ? Math.min(9999, Math.max(0, Number(body.results_count))) : null;
  const pageReferrer = body.page_referrer ? String(body.page_referrer).slice(0, 200) : null;
  const userAgent    = summarizeUserAgent(req.headers.get('user-agent'));

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  await sb.from('help_events').insert({
    event_type: eventType,
    tenant_id: payload.tid,
    admin_user_id: payload.sub,
    query,
    article_slug: articleSlug,
    duration_ms: durationMs,
    results_count: resultsCount,
    page_referrer: pageReferrer,
    user_agent: userAgent,
  });

  return new Response(null, { status: 204, headers: cors });
});

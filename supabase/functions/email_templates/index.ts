// =============================================================================
// email_templates — admin CRUD for tenant email overrides
// =============================================================================
// Auth: tenant admin with 'communications' scope (or owner template).
//
// Actions:
//   { action: 'list' }
//     → { ok, templates: [{ key, label, description, audience, variables,
//                            default_subject, default_body_html,
//                            override?: { subject, body_html, enabled, updated_at } }] }
//
//   { action: 'get', key }
//     → { ok, template: <registry entry>, override: <row or null> }
//
//   { action: 'save', key, subject, body_html, enabled }
//     → { ok }     upserts the override
//
//   { action: 'reset', key }
//     → { ok }     deletes the override (revert to default)
//
//   { action: 'preview', key, subject, body_html, variables? }
//     → { ok, subject, html }    renders without saving
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { EMAIL_REGISTRY, getRegistryEntry, renderPreview } from '../_shared/email_template.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type AdminPayload = { sub: string; kind: string; tid: string; slug: string; scopes?: string[]; role_template?: string; is_super?: boolean };
async function verifyAdmin(token: string): Promise<AdminPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as AdminPayload;
  } catch { return null; }
}
function hasCommScopeFromJwt(p: AdminPayload): boolean {
  if (p.is_super) return true;
  if (p.role_template === 'owner') return true;
  return Array.isArray(p.scopes) && (p.scopes.includes('communications') || p.scopes.includes('announcements'));
}

// JWT-first, DB-fallback. Old tokens (issued before role_template/scopes
// were embedded in the payload) lack those fields; we fall back to a
// per-request DB lookup so they still work without forcing re-login.
async function hasCommScope(sb: ReturnType<typeof createClient>, p: AdminPayload): Promise<boolean> {
  if (hasCommScopeFromJwt(p)) return true;
  if (p.role_template !== undefined && p.scopes !== undefined) return false;  // claims present but failed
  const { data: admin } = await sb.from('admin_users')
    .select('role_template, scopes, is_super, active').eq('id', p.sub).maybeSingle();
  if (!admin || !admin.active) return false;
  if (admin.is_super) return true;
  if (admin.role_template === 'owner') return true;
  const scopes = (admin.scopes as string[] | null) ?? [];
  return scopes.includes('communications') || scopes.includes('announcements');
}

// Sample variables used by the Preview action when the admin hasn't set them.
// Keep these realistic so the preview reads like a real email.
const SAMPLE_VARS: Record<string, string> = {
  tenant_name:       'Bishop Estates Cabana Club',
  primary_name:      'Jane Smith',
  family_name:       'Smith Family',
  tier_label:        'Family',
  tier_price:        '$600',
  num_adults:        '2',
  num_kids:          '1',
  payment_method:    'Venmo',
  venmo_handle:      'bishopestates',
  first_amount:      '$300',
  second_amount:     '$300',
  final_due_date:    '2026-07-01',
  sign_in_link:      'https://bishopestates.poolsideapp.com/m/verify.html#token=sample-link',
  amount:            '$300',
  sequence:          '2',
  next_amount:       '$300',
  next_due_date:     '2026-07-01',
  admin_notes:       '(Admin reason from the rejection form would appear here.)',
  // Auto-renew: without these the preview shows a board "renewing your
  // membership on ", which reads as a bug in the template they are editing.
  season:            '2027',
  charge_date:       'December 15, 2026',
  manage_url:        'https://bishopestates.poolsideapp.com/m/renew.html',
  renew_link:        'https://bishopestates.poolsideapp.com/renew.html?t=sample-link',
  club_url:          'https://bishopestates.poolsideapp.com',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  if (!(await hasCommScope(sb, payload))) {
    return jsonResponse({ ok: false, error: 'Missing communications scope' }, 403);
  }

  if (action === 'list') {
    const { data: overrides } = await sb.from('email_templates')
      .select('key, subject, body_html, enabled, updated_at')
      .eq('tenant_id', payload.tid);
    const overrideMap: Record<string, { subject: string; body_html: string; enabled: boolean; updated_at: string }> = {};
    (overrides ?? []).forEach(o => {
      overrideMap[o.key as string] = {
        subject: o.subject as string, body_html: o.body_html as string,
        enabled: !!o.enabled, updated_at: o.updated_at as string,
      };
    });
    const templates = EMAIL_REGISTRY.map(def => ({
      key: def.key,
      label: def.label,
      description: def.description,
      audience: def.audience,
      variables: def.variables,
      default_subject: def.default_subject,
      default_body_html: def.default_body_html,
      override: overrideMap[def.key] ?? null,
    }));
    return jsonResponse({ ok: true, templates });
  }

  if (action === 'get') {
    const key = String(body.key ?? '');
    const def = getRegistryEntry(key);
    if (!def) return jsonResponse({ ok: false, error: 'Unknown template key' }, 404);
    const { data: override } = await sb.from('email_templates')
      .select('subject, body_html, enabled, updated_at')
      .eq('tenant_id', payload.tid).eq('key', key).maybeSingle();
    return jsonResponse({ ok: true, template: def, override: override ?? null });
  }

  if (action === 'save') {
    const key = String(body.key ?? '');
    const def = getRegistryEntry(key);
    if (!def) return jsonResponse({ ok: false, error: 'Unknown template key' }, 404);
    const subject = String(body.subject ?? '').trim();
    const body_html = String(body.body_html ?? '').trim();
    const enabled = body.enabled === false ? false : true;
    if (!subject || !body_html) return jsonResponse({ ok: false, error: 'subject and body_html required' }, 400);
    const updated_by = payload.synthetic ? null : payload.sub;
    const { error } = await sb.from('email_templates').upsert({
      tenant_id: payload.tid,
      key, subject, body_html, enabled, updated_by,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'tenant_id,key' });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'reset') {
    const key = String(body.key ?? '');
    if (!key) return jsonResponse({ ok: false, error: 'key required' }, 400);
    const { error } = await sb.from('email_templates').delete()
      .eq('tenant_id', payload.tid).eq('key', key);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'preview') {
    const key = String(body.key ?? '');
    const def = getRegistryEntry(key);
    if (!def) return jsonResponse({ ok: false, error: 'Unknown template key' }, 404);
    const customSubject = body.subject != null ? String(body.subject) : null;
    const customBody    = body.body_html != null ? String(body.body_html) : null;
    const userVars = (body.variables as Record<string, string> | undefined) || {};
    // Merge sample defaults with any vars the admin passed (for tenant-specific preview)
    const vars: Record<string, string> = { ...SAMPLE_VARS };
    // Pull tenant-specific defaults so preview reads as the actual club
    const { data: tenant } = await sb.from('tenants').select('display_name, slug').eq('id', payload.tid).maybeSingle();
    if (tenant) {
      vars.tenant_name = tenant.display_name as string;
      vars.club_url    = `https://${tenant.slug as string}.poolsideapp.com`;
    }
    Object.assign(vars, userVars);
    const rendered = renderPreview(key, customSubject, customBody, vars);
    return jsonResponse({ ok: true, subject: rendered.subject, html: rendered.html });
  }

  // ── The outbox ─────────────────────────────────────────────────────────
  // Bulk mail waiting for tomorrow's Resend allowance. This exists only
  // because the free plan caps at 100 emails a day; on a paid plan there is
  // no daily quota, nothing ever queues, and the UI hides itself rather than
  // showing a board a permanently empty box it has to reason about.
  //
  // Tenant-scoped, but the underlying allowance is NOT: one Resend account
  // serves every club, so a busy day at one club delays another. Said plainly
  // in the response rather than left for someone to deduce.

  if (action === 'outbox') {
    const { data: queued } = await sb.from('email_queue')
      .select('id, to_email, subject, category, attempts, last_error, created_at, not_before')
      .eq('tenant_id', payload.tid).eq('status', 'queued')
      .order('created_at', { ascending: true }).limit(200);

    const { data: failed } = await sb.from('email_queue')
      .select('id, to_email, subject, attempts, last_error, created_at')
      .eq('tenant_id', payload.tid).eq('status', 'failed')
      .order('created_at', { ascending: false }).limit(50);

    const { count: sentCount } = await sb.from('email_queue')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', payload.tid).eq('status', 'sent');

    const { remainingToday, providerQuotaUsedToday, providerDailyLimit } =
      await import('../_shared/email_budget.ts');
    const quotaUsed = await providerQuotaUsedToday(sb);

    // The drain rides on the 14:00 UTC daily cron.
    const next = new Date();
    next.setUTCHours(14, 0, 0, 0);
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);

    return jsonResponse({
      ok: true,
      // Null means Resend has never sent us a quota header, which they only
      // do on the free plan — so there is no daily ceiling to worry about.
      quota_limited: quotaUsed !== null,
      quota_used: quotaUsed,
      quota_limit: quotaUsed !== null ? providerDailyLimit() : null,
      remaining_today: await remainingToday(sb),
      next_send_at: next.toISOString(),
      queued: queued ?? [],
      failed: failed ?? [],
      sent_total: sentCount ?? 0,
    });
  }

  if (action === 'outbox_send_now') {
    // Sends what today's allowance still permits, this club's queue only.
    // Everyone shares the allowance, so this can take headroom from another
    // club — fine at this size, worth revisiting at twenty.
    const { drainEmailQueue } = await import('../_shared/email_budget.ts');
    const r = await drainEmailQueue(sb, { tenantId: payload.tid });
    return jsonResponse({ ok: true, ...r });
  }

  if (action === 'outbox_cancel') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('email_queue')
      .update({ status: 'cancelled' })
      .eq('id', id).eq('tenant_id', payload.tid).eq('status', 'queued');
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

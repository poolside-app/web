// =============================================================================
// feedback — anonymous feedback box (public submit + admin list/resolve)
// =============================================================================
// Public surface: anyone on the public or member home can submit a photo +
// comment without signing in. We hash their IP to rate-limit obvious abuse
// (5 submissions per IP per hour) but never expose it.
//
// Admin surface: tenant admin lists submissions, marks resolved, assigns
// notes. Notification email fires on submit to the tenant's notify list.
//
// Actions:
//   { action: 'submit', slug, comment, photo? }            — public, no auth
//   { action: 'list', status? }                             — admin
//   { action: 'update_status', id, status, admin_notes? }   — admin
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

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

type AdminPayload = { sub: string; kind: string; tid: string };
async function verifyTenantAdmin(token: string): Promise<AdminPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as AdminPayload;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── submit (public, no auth) ───────────────────────────────────────────
  if (action === 'submit') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const comment = String(body.comment ?? '').trim();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    if (!comment) return jsonResponse({ ok: false, error: 'Comment is required' }, 400);
    if (comment.length > 2000) return jsonResponse({ ok: false, error: 'Comment is too long' }, 400);

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, status').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    if (tenant.status === 'churned') return jsonResponse({ ok: false, error: 'Club inactive' }, 403);

    // IP rate limit — hash from x-forwarded-for first hop. 5 submissions /
    // hour / IP / tenant is plenty for honest reporters and stops casual abuse.
    const xff = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '';
    const ip  = xff.split(',')[0].trim() || 'unknown';
    const ipHash = await sha256Hex(ip + ':' + tenant.id);
    const { count } = await sb.from('feedback_submissions')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenant.id).eq('ip_hash', ipHash)
      .gte('created_at', new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= 5) {
      return jsonResponse({ ok: false, error: 'Too many submissions — please wait an hour and try again.' }, 429);
    }

    // Optional photo — { content_type, base64 }. Lands in club-assets bucket.
    let photo_url: string | null = null;
    const ct = String(body.photo_content_type ?? '').trim();
    const b64 = String(body.photo_base64 ?? '');
    if (ct && b64) {
      const ALLOWED: Record<string, string> = {
        'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      };
      if (!ALLOWED[ct]) return jsonResponse({ ok: false, error: 'Only JPG/PNG/WebP/GIF photos allowed' }, 400);
      let bytes: Uint8Array;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return jsonResponse({ ok: false, error: 'Invalid photo data' }, 400);
      }
      if (bytes.byteLength > 8 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'Photo too large (max 8 MB)' }, 400);
      }
      const id = crypto.randomUUID();
      const path = `${tenant.id}/feedback/${id}.${ALLOWED[ct]}`;
      const { error: upErr } = await sb.storage.from('club-assets')
        .upload(path, bytes, { contentType: ct, upsert: false });
      if (upErr) return jsonResponse({ ok: false, error: upErr.message }, 500);
      const { data: pub } = sb.storage.from('club-assets').getPublicUrl(path);
      photo_url = pub.publicUrl;
    }

    const { data: row, error } = await sb.from('feedback_submissions').insert({
      tenant_id: tenant.id,
      photo_url,
      comment,
      ip_hash: ipHash,
    }).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Open an admin task so the queue surfaces this
    try {
      await sb.from('admin_tasks').insert({
        tenant_id: tenant.id,
        target_scopes: ['operations'],
        kind: 'feedback.submitted',
        summary: `Anonymous feedback: "${comment.slice(0, 60)}${comment.length > 60 ? '…' : ''}"`,
        link_url: '/club/admin/feedback.html',
        source_kind: 'feedback', source_id: row.id,
      });
    } catch { /* best-effort */ }

    return jsonResponse({ ok: true });
  }

  // ── admin actions (require tenant admin token) ─────────────────────────
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const admin = token ? await verifyTenantAdmin(token) : null;
  if (!admin) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  if (action === 'list') {
    const status = String(body.status ?? '').trim();
    let q = sb.from('feedback_submissions')
      .select('id, photo_url, comment, status, admin_notes, resolved_at, created_at')
      .eq('tenant_id', admin.tid)
      .order('created_at', { ascending: false })
      .limit(200);
    if (status && ['new','in_progress','resolved','spam'].includes(status)) {
      q = q.eq('status', status);
    }
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, items: data ?? [] });
  }

  if (action === 'update_status') {
    const id = String(body.id ?? '');
    const status = String(body.status ?? '');
    if (!id || !['new','in_progress','resolved','spam'].includes(status)) {
      return jsonResponse({ ok: false, error: 'id + valid status required' }, 400);
    }
    const patch: Record<string, unknown> = { status };
    if (body.admin_notes !== undefined) patch.admin_notes = String(body.admin_notes ?? '').slice(0, 2000);
    if (status === 'resolved' || status === 'spam') {
      patch.resolved_at = new Date().toISOString();
      patch.resolved_by = admin.sub;
    } else {
      patch.resolved_at = null;
      patch.resolved_by = null;
    }
    const { error } = await sb.from('feedback_submissions')
      .update(patch).eq('id', id).eq('tenant_id', admin.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

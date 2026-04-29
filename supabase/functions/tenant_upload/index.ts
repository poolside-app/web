// =============================================================================
// tenant_upload — Upload an image to club-assets storage
// =============================================================================
// Auth: tenant admin token. Files land at
//   club-assets/<tenant_id>/<random>.<ext>
// and the bucket is public-read, so the returned URL can be embedded directly
// on the tenant's pages.
//
// Body (JSON):
//   { filename, content_type, base64 }
//
// Returns:
//   { ok, url, path }
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

const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf',
]);
const MAX_BYTES = 25 * 1024 * 1024;  // 25 MB (PDFs run bigger than images)

function extFor(contentType: string, filename: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'application/pdf': 'pdf',
  };
  if (map[contentType]) return map[contentType];
  const m = filename.match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : 'bin';
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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, error: 'Invalid JSON' }, 400); }

  const filename     = String(body.filename ?? '').trim();
  const content_type = String(body.content_type ?? '').trim();
  const base64       = String(body.base64 ?? '');
  if (!filename || !content_type || !base64) {
    return jsonResponse({ ok: false, error: 'filename, content_type, and base64 are required' }, 400);
  }
  if (!ALLOWED_TYPES.has(content_type)) {
    return jsonResponse({ ok: false, error: 'Only JPG, PNG, WebP, GIF, or PDF files are allowed' }, 400);
  }

  // Decode base64 → Uint8Array
  let bytes: Uint8Array;
  try {
    const bin = atob(base64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch {
    return jsonResponse({ ok: false, error: 'Invalid base64 data' }, 400);
  }
  if (bytes.byteLength > MAX_BYTES) {
    return jsonResponse({ ok: false, error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` }, 400);
  }

  const id = crypto.randomUUID();
  const path = `${payload.tid}/${id}.${extFor(content_type, filename)}`;

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const { error } = await sb.storage.from('club-assets')
    .upload(path, bytes, { contentType: content_type, upsert: false });
  if (error) return jsonResponse({ ok: false, error: error.message }, 500);

  const { data: pub } = sb.storage.from('club-assets').getPublicUrl(path);
  return jsonResponse({ ok: true, url: pub.publicUrl, path });
});

// =============================================================================
// board_preview — a look-only preview's reads of the club's screens
// =============================================================================
// PLAN.md CC6 (Doug 11/6): "just see and interacti with thier interface". In
// the President's look-only preview of a board member or a position
// (Settings → Board), each screen's reads come here instead of going to the
// screen's own function, which would refuse the preview's sign-in:
//
//   POST { fn, action, body }   Authorization: Bearer <the preview's sign-in>
//
// In this order: the sign-in must be a preview's (`board_view`, an hour); the
// read must be on PREVIEW_READS (_shared/board_view.ts: reads that write
// nothing, every one checked by scripts/test_board_view.mjs); the President
// who opened the preview must still be an active President of the club. Only
// then is the screen's function asked, as that President, with a sign-in that
// lasts a minute and with the checked action, and its answer is passed back
// as the preview (whether they're the President, who "me" is). Anything else
// is refused "look only". The answer is the club's own data the President can
// already see; what differs per person (their screens and buttons) the page
// works out from `me`.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { LOOK_ONLY, NIL, asView, previewReadAllowed, previewPatch } from '../_shared/board_view.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

async function key(): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const isOwnerRow = (a: { role_template?: string | null; roles?: string[] | null }) =>
  (a.role_template ?? 'owner') === 'owner' || (a.roles ?? []).includes('owner');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return j({ ok: false, error: 'POST required' }, 405);
  if (!JWT_SECRET) return j({ ok: false, error: 'Not set up' }, 500);

  // 1. Only a preview's sign-in.
  const hdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  let claims: Record<string, unknown> | null = null;
  try { claims = hdr.startsWith('Bearer ') ? await verify(hdr.slice(7), await key()) as Record<string, unknown> : null; } catch { claims = null; }
  const view = asView(claims);
  if (!view) return j({ ok: false, error: 'This preview has ended. Open it again from Settings → Board.' }, 401);

  // 2. Only a read on the list.
  let req0: Record<string, unknown> = {};
  try { req0 = await req.json(); } catch { /* keep empty */ }
  const fn = String(req0.fn ?? ''), action = String(req0.action ?? '');
  const inner = (req0.body && typeof req0.body === 'object' && !Array.isArray(req0.body)) ? req0.body as Record<string, unknown> : {};
  if (!previewReadAllowed(fn, action)) return j({ ok: false, error: LOOK_ONLY, look_only: true }, 403);

  // 3. The President who opened it is still an active President of this club.
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const [{ data: by }, { data: tenant }] = await Promise.all([
    sb.from('admin_users').select('id, active, role_template, roles').eq('id', view.by).eq('tenant_id', view.tid).maybeSingle(),
    sb.from('tenants').select('slug').eq('id', view.tid).maybeSingle(),
  ]);
  if (!by || !by.active || !isOwnerRow(by) || !tenant) return j({ ok: false, error: 'This preview has ended. Open it again from Settings → Board.' }, 401);
  // Whether the person previewed is a President (a position's preview never is
  // unless the position has full access; the page works that out from `me`).
  let asOwner = false;
  if (!view.pos) {
    const { data: who } = await sb.from('admin_users').select('role_template, roles, active').eq('id', view.sub).eq('tenant_id', view.tid).maybeSingle();
    if (!who || !who.active) return j({ ok: false, error: 'This preview has ended. Open it again from Settings → Board.' }, 401);
    asOwner = isOwnerRow(who);
  }

  // 4. Ask the screen's own function, as the President, for a minute.
  const now = Math.floor(Date.now() / 1000);
  const tok = await create({ alg: 'HS256', typ: 'JWT' }, {
    sub: by.id, kind: 'tenant_admin', tid: view.tid, slug: tenant.slug,
    role_template: by.role_template ?? 'owner', scopes: [], is_super: false, exp: now + 60,
  }, await key());
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ ...inner, action }),
  });
  const text = await res.text();
  let out = text;
  try { out = JSON.stringify(previewPatch(JSON.parse(text), { me: view.pos ? NIL : view.sub, isOwner: asOwner })); } catch { /* not JSON: pass it on */ }
  return new Response(out, { status: res.status, headers: { ...cors, 'content-type': 'application/json' } });
});

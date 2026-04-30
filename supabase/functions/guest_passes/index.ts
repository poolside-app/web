// =============================================================================
// guest_passes — Pre-paid guest pass packs + redemption log
// =============================================================================
// Member actions (member JWT):
//   { action: 'my_packs' }
//     → { ok, packs: [...] (with remaining), recent_uses: [...] }
//   { action: 'redeem', pack_id, guest_name, notes? }
//     → { ok, use, pack }                — atomic decrement
//
// Admin actions (tenant_admin JWT):
//   { action: 'list', household_id?, only_unpaid? }
//     → { ok, packs: [...] }
//   { action: 'issue', household_id, total_count, label?, price_cents?, paid?, expires_on?, notes? }
//     → { ok, pack }
//   { action: 'mark_paid', pack_id, paid }
//     → { ok, pack }
//   { action: 'archive', pack_id }
//     → { ok }
//   { action: 'usage', pack_id }
//     → { ok, pack, uses: [...] }
//   { action: 'admin_redeem', pack_id, guest_name, ... }
//     → { ok, use, pack }
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

type Payload = { sub: string; kind: string; tid: string; hid?: string };
async function verifyToken(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (!p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const PACK_FIELDS = 'id, tenant_id, household_id, label, total_count, used_count, paid, price_cents, expires_on, notes, active, created_at, updated_at';
const USE_FIELDS  = 'id, tenant_id, pack_id, household_id, guest_name, redeemed_by_member, redeemed_by_label, notes, redeemed_at';

function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function intOrDefault(v: unknown, d: number): number {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : d;
}
function dateOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function isExpired(pack: { expires_on: string | null }): boolean {
  if (!pack.expires_on) return false;
  return new Date(pack.expires_on + 'T23:59:59Z').getTime() < Date.now();
}
function withRemaining<T extends { total_count: number; used_count: number; expires_on: string | null }>(p: T) {
  return { ...p, remaining: Math.max(0, p.total_count - p.used_count), expired: isExpired(p) };
}

// Atomic decrement via the SQL UPDATE … RETURNING trick. We avoid a
// race-y SELECT-then-UPDATE by relying on the row-level write lock: bump
// used_count only when total_count - used_count > 0.
async function tryConsumeOne(
  sb: ReturnType<typeof createClient>, packId: string, tenantId: string,
): Promise<{ ok: boolean; pack?: Record<string, unknown>; error?: string }> {
  // Check current state first to give a friendlier error than "constraint violated".
  const { data: pack } = await sb.from('guest_pass_packs').select(PACK_FIELDS)
    .eq('id', packId).eq('tenant_id', tenantId).maybeSingle();
  if (!pack) return { ok: false, error: 'Pack not found' };
  if (!pack.active) return { ok: false, error: 'Pack is archived' };
  if (!pack.paid) return { ok: false, error: 'Pack is unpaid — pay before redeeming' };
  if (isExpired(pack)) return { ok: false, error: 'Pack expired' };
  if (pack.used_count >= pack.total_count) return { ok: false, error: 'No passes left' };

  // Use the gt() guard so two concurrent redemptions can't both succeed.
  const { data: updated, error } = await sb.from('guest_pass_packs')
    .update({ used_count: pack.used_count + 1, updated_at: new Date().toISOString() })
    .eq('id', packId)
    .eq('tenant_id', tenantId)
    .eq('used_count', pack.used_count)            // optimistic: only if state hasn't changed
    .select(PACK_FIELDS).single();
  if (error) return { ok: false, error: error.message };
  if (!updated) return { ok: false, error: 'Concurrent redemption — try again' };
  return { ok: true, pack: updated };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Auth required for everything
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyToken(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;
  const isMember = payload.kind === 'member';
  const isAdmin  = payload.kind === 'tenant_admin';

  // ── Member actions ──────────────────────────────────────────────────────
  if (isMember) {
    const HID = payload.hid;
    if (!HID) return jsonResponse({ ok: false, error: 'Member token missing household' }, 401);

    if (action === 'my_packs') {
      const { data: packs } = await sb.from('guest_pass_packs').select(PACK_FIELDS)
        .eq('tenant_id', TID).eq('household_id', HID).eq('active', true)
        .order('created_at', { ascending: false });
      const { data: uses } = await sb.from('guest_pass_uses').select(USE_FIELDS)
        .eq('tenant_id', TID).eq('household_id', HID)
        .order('redeemed_at', { ascending: false }).limit(20);
      return jsonResponse({
        ok: true,
        packs: (packs ?? []).map(withRemaining),
        recent_uses: uses ?? [],
      });
    }

    if (action === 'redeem') {
      const pack_id = String(body.pack_id ?? '');
      const guest_name = String(body.guest_name ?? '').trim();
      if (!pack_id || !guest_name) {
        return jsonResponse({ ok: false, error: 'pack_id and guest_name required' }, 400);
      }
      // Confirm the pack belongs to this household before consuming
      const { data: pack } = await sb.from('guest_pass_packs').select('id, household_id')
        .eq('id', pack_id).eq('tenant_id', TID).maybeSingle();
      if (!pack) return jsonResponse({ ok: false, error: 'Pack not found' }, 404);
      if (pack.household_id !== HID) return jsonResponse({ ok: false, error: 'Not your pack' }, 403);

      // Member name snapshot for the audit trail
      const { data: me } = await sb.from('household_members').select('name')
        .eq('id', payload.sub as string).maybeSingle();

      const consume = await tryConsumeOne(sb, pack_id, TID);
      if (!consume.ok) return jsonResponse({ ok: false, error: consume.error }, 409);

      const { data: use, error } = await sb.from('guest_pass_uses').insert({
        tenant_id: TID, pack_id, household_id: HID,
        guest_name,
        redeemed_by_member: payload.sub as string,
        redeemed_by_label: me?.name ?? null,
        notes: strOrNull(body.notes),
      }).select(USE_FIELDS).single();
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true, use, pack: withRemaining(consume.pack as { total_count: number; used_count: number; expires_on: string | null }) });
    }

    return jsonResponse({ ok: false, error: `Unknown member action: ${action}` }, 400);
  }

  // ── Admin actions ──────────────────────────────────────────────────────
  if (!isAdmin) return jsonResponse({ ok: false, error: 'Forbidden' }, 403);

  if (action === 'list') {
    let q = sb.from('guest_pass_packs').select(PACK_FIELDS).eq('tenant_id', TID);
    if (body.household_id) q = q.eq('household_id', String(body.household_id));
    if (body.only_unpaid)  q = q.eq('paid', false);
    if (!body.include_archived) q = q.eq('active', true);
    q = q.order('created_at', { ascending: false });
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Decorate with household family_name for the admin view
    const hids = [...new Set((data ?? []).map(p => p.household_id))];
    const { data: households } = hids.length
      ? await sb.from('households').select('id, family_name').in('id', hids)
      : { data: [] };
    const byHid = new Map((households ?? []).map(h => [h.id, h.family_name]));
    return jsonResponse({
      ok: true,
      packs: (data ?? []).map(p => ({ ...withRemaining(p), family_name: byHid.get(p.household_id) ?? null })),
    });
  }

  if (action === 'issue') {
    const household_id = String(body.household_id ?? '');
    const total_count  = intOrDefault(body.total_count, 1);
    if (!household_id) return jsonResponse({ ok: false, error: 'household_id required' }, 400);
    if (total_count < 1) return jsonResponse({ ok: false, error: 'total_count must be at least 1' }, 400);

    // Make sure the household belongs to this tenant
    const { data: hh } = await sb.from('households').select('id, tenant_id, active')
      .eq('id', household_id).maybeSingle();
    if (!hh || hh.tenant_id !== TID) return jsonResponse({ ok: false, error: 'Household not found' }, 404);

    const { data, error } = await sb.from('guest_pass_packs').insert({
      tenant_id: TID, household_id,
      label:       strOrNull(body.label) ?? 'Guest passes',
      total_count, used_count: 0,
      paid:        body.paid === true,
      price_cents: intOrDefault(body.price_cents, 0),
      expires_on:  dateOrNull(body.expires_on),
      notes:       strOrNull(body.notes),
    }).select(PACK_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, pack: withRemaining(data) });
  }

  if (action === 'mark_paid') {
    const pack_id = String(body.pack_id ?? '');
    if (!pack_id) return jsonResponse({ ok: false, error: 'pack_id required' }, 400);
    const paid = body.paid !== false;
    const { data, error } = await sb.from('guest_pass_packs')
      .update({ paid, updated_at: new Date().toISOString() })
      .eq('id', pack_id).eq('tenant_id', TID).select(PACK_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, pack: withRemaining(data) });
  }

  if (action === 'archive') {
    const pack_id = String(body.pack_id ?? '');
    if (!pack_id) return jsonResponse({ ok: false, error: 'pack_id required' }, 400);
    const { error } = await sb.from('guest_pass_packs')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', pack_id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'usage') {
    const pack_id = String(body.pack_id ?? '');
    if (!pack_id) return jsonResponse({ ok: false, error: 'pack_id required' }, 400);
    const { data: pack } = await sb.from('guest_pass_packs').select(PACK_FIELDS)
      .eq('id', pack_id).eq('tenant_id', TID).maybeSingle();
    if (!pack) return jsonResponse({ ok: false, error: 'Pack not found' }, 404);
    const { data: uses } = await sb.from('guest_pass_uses').select(USE_FIELDS)
      .eq('tenant_id', TID).eq('pack_id', pack_id)
      .order('redeemed_at', { ascending: false });
    return jsonResponse({ ok: true, pack: withRemaining(pack), uses: uses ?? [] });
  }

  if (action === 'admin_redeem') {
    const pack_id = String(body.pack_id ?? '');
    const guest_name = String(body.guest_name ?? '').trim();
    if (!pack_id || !guest_name) return jsonResponse({ ok: false, error: 'pack_id and guest_name required' }, 400);
    const consume = await tryConsumeOne(sb, pack_id, TID);
    if (!consume.ok) return jsonResponse({ ok: false, error: consume.error }, 409);
    const { data: use, error } = await sb.from('guest_pass_uses').insert({
      tenant_id: TID, pack_id,
      household_id: (consume.pack as { household_id: string }).household_id,
      guest_name,
      redeemed_by_label: 'Admin',
      notes: strOrNull(body.notes),
    }).select(USE_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, use, pack: withRemaining(consume.pack as { total_count: number; used_count: number; expires_on: string | null }) });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

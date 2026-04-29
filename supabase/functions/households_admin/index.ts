// =============================================================================
// households_admin — Per-tenant CRUD over households + members
// =============================================================================
// Auth: tenant admin token (HS256, kind='tenant_admin'). Tenant scope is
// pulled from the token; the body's payloads can never reference another
// tenant's rows.
//
// Actions:
//   { action: 'list' }
//     → { ok, households: [{ ...household, members: [...] }] }
//
//   { action: 'create_household',
//     family_name, tier?, fob_number?, dues_paid_for_year?, paid_until_year?,
//     address?, city?, zip?, emergency_contact?, notes?,
//     primary: { name, phone_e164, email?, can_unlock_gate?, can_book_parties? } }
//     → { ok, household_id, primary_id }
//
//   { action: 'update_household', id, ...patch }
//     → { ok }
//
//   { action: 'delete_household', id }
//     → { ok }
//
//   { action: 'add_member', household_id, name, role, phone_e164?, email?,
//                           can_unlock_gate?, can_book_parties? }
//     → { ok, member_id }
//
//   { action: 'update_member', id, ...patch }
//     → { ok }
//
//   { action: 'remove_member', id }
//     → { ok }
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

function normalizePhoneE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) {
    return /^\+\d{8,15}$/.test(digits) ? digits : null;
  }
  if (/^\d{10}$/.test(digits)) return '+1' + digits;
  if (/^1\d{10}$/.test(digits)) return '+' + digits;
  return null;
}
function strOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}
function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

async function audit(
  sb: ReturnType<typeof createClient>,
  tenant_id: string, payload: Payload,
  kind: string, entity_type: string, entity_id: string | null, summary: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await sb.from('audit_log').insert({
      tenant_id, kind, entity_type, entity_id,
      summary,
      actor_id: payload.sub === '00000000-0000-0000-0000-000000000000' ? null : payload.sub,
      actor_kind: 'tenant_admin',
      actor_label: null,
      metadata: metadata ?? null,
    });
  } catch { /* audit failures should never break the operation */ }
}

const HH_FIELDS = [
  'id','family_name','tier','fob_number','dues_paid_for_year','paid_until_year',
  'address','city','zip','emergency_contact','notes','active','created_at',
].join(', ');
const HM_FIELDS = [
  'id','household_id','name','phone_e164','email','role',
  'can_unlock_gate','can_book_parties','active','confirmed_at','last_seen_at','created_at',
].join(', ');

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

  // ── list ─────────────────────────────────────────────────────────────
  if (action === 'list') {
    const { data: households, error } = await sb.from('households')
      .select(HH_FIELDS)
      .eq('tenant_id', TID)
      .order('family_name', { ascending: true });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    const ids = (households ?? []).map(h => h.id as string);
    const { data: members } = ids.length
      ? await sb.from('household_members')
          .select(HM_FIELDS)
          .eq('tenant_id', TID)
          .in('household_id', ids)
          .order('role', { ascending: true })
          .order('created_at', { ascending: true })
      : { data: [] };

    const byHh = new Map<string, unknown[]>();
    for (const m of (members ?? [])) {
      const arr = byHh.get(m.household_id as string) ?? [];
      arr.push(m);
      byHh.set(m.household_id as string, arr);
    }
    const enriched = (households ?? []).map(h => ({
      ...h,
      members: byHh.get(h.id as string) ?? [],
    }));
    return jsonResponse({ ok: true, households: enriched });
  }

  // ── create_household ─────────────────────────────────────────────────
  if (action === 'create_household') {
    const family_name = String(body.family_name ?? '').trim();
    if (!family_name) return jsonResponse({ ok: false, error: 'Family name is required' }, 400);

    const primary = (body.primary ?? {}) as Record<string, unknown>;
    const pName  = String(primary.name ?? '').trim();
    const pPhoneRaw = String(primary.phone_e164 ?? '').trim();
    if (!pName)  return jsonResponse({ ok: false, error: 'Primary contact name is required' }, 400);
    if (!pPhoneRaw) return jsonResponse({ ok: false, error: 'Primary phone is required' }, 400);
    const pPhone = normalizePhoneE164(pPhoneRaw);
    if (!pPhone) return jsonResponse({ ok: false, error: 'Invalid primary phone — use 10-digit US or +CC format' }, 400);

    // Phone must be free *within this tenant*
    const { data: clash } = await sb.from('household_members')
      .select('id').eq('tenant_id', TID).eq('phone_e164', pPhone).eq('active', true).maybeSingle();
    if (clash) return jsonResponse({ ok: false, error: 'A household member with that phone already exists' }, 409);

    const fobNumber = strOrNull(body.fob_number);
    if (fobNumber) {
      const { data: fobClash } = await sb.from('households')
        .select('id').eq('tenant_id', TID).eq('fob_number', fobNumber).maybeSingle();
      if (fobClash) return jsonResponse({ ok: false, error: 'A household with that fob # already exists' }, 409);
    }

    const hhRow = {
      tenant_id: TID,
      family_name,
      tier: strOrNull(body.tier) ?? 'family',
      fob_number: fobNumber,
      dues_paid_for_year: !!body.dues_paid_for_year,
      paid_until_year: intOrNull(body.paid_until_year),
      address: strOrNull(body.address),
      city: strOrNull(body.city),
      zip: strOrNull(body.zip),
      emergency_contact: strOrNull(body.emergency_contact),
      notes: strOrNull(body.notes),
      active: true,
    };
    const { data: hh, error: hhErr } = await sb.from('households')
      .insert(hhRow).select('id').single();
    if (hhErr) return jsonResponse({ ok: false, error: hhErr.message }, 500);

    const pmRow = {
      tenant_id: TID,
      household_id: hh.id,
      name: pName,
      phone_e164: pPhone,
      email: strOrNull(primary.email),
      role: 'primary',
      can_unlock_gate: primary.can_unlock_gate !== false,
      can_book_parties: primary.can_book_parties !== false,
      active: true,
      confirmed_at: new Date().toISOString(),  // admin add → auto-confirmed
    };
    const { data: pm, error: pmErr } = await sb.from('household_members')
      .insert(pmRow).select('id').single();
    if (pmErr) {
      // Roll back the household so we don't leave an orphan
      await sb.from('households').delete().eq('id', hh.id);
      return jsonResponse({ ok: false, error: pmErr.message }, 500);
    }
    await audit(sb, TID, payload, 'household.create', 'household', hh.id, `Created household: ${family_name}`);
    return jsonResponse({ ok: true, household_id: hh.id, primary_id: pm.id });
  }

  // ── update_household ─────────────────────────────────────────────────
  if (action === 'update_household') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const patch: Record<string, unknown> = {};
    if (body.family_name !== undefined) {
      const v = String(body.family_name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Family name cannot be empty' }, 400);
      patch.family_name = v;
    }
    if (body.tier !== undefined) patch.tier = strOrNull(body.tier) ?? 'family';
    if (body.fob_number !== undefined) {
      const v = strOrNull(body.fob_number);
      if (v) {
        const { data: fobClash } = await sb.from('households')
          .select('id').eq('tenant_id', TID).eq('fob_number', v).neq('id', id).maybeSingle();
        if (fobClash) return jsonResponse({ ok: false, error: 'Another household already has that fob #' }, 409);
      }
      patch.fob_number = v;
    }
    if (body.dues_paid_for_year !== undefined) patch.dues_paid_for_year = !!body.dues_paid_for_year;
    if (body.paid_until_year !== undefined)    patch.paid_until_year    = intOrNull(body.paid_until_year);
    if (body.address !== undefined)            patch.address            = strOrNull(body.address);
    if (body.city !== undefined)               patch.city               = strOrNull(body.city);
    if (body.zip !== undefined)                patch.zip                = strOrNull(body.zip);
    if (body.emergency_contact !== undefined)  patch.emergency_contact  = strOrNull(body.emergency_contact);
    if (body.notes !== undefined)              patch.notes              = strOrNull(body.notes);
    if (body.active !== undefined)             patch.active             = !!body.active;
    if (Object.keys(patch).length === 0) return jsonResponse({ ok: true, noop: true });

    const { error } = await sb.from('households')
      .update(patch).eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await audit(sb, TID, payload, 'household.update', 'household', id,
      `Updated household ${patch.family_name ?? id}`, patch);
    return jsonResponse({ ok: true });
  }

  // ── delete_household ─────────────────────────────────────────────────
  if (action === 'delete_household') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    // Soft-delete: keep history, flip active=false on the household and
    // every member. Also wipe in-flight member sessions.
    const { error: hhErr } = await sb.from('households')
      .update({ active: false }).eq('id', id).eq('tenant_id', TID);
    if (hhErr) return jsonResponse({ ok: false, error: hhErr.message }, 500);

    await sb.from('household_members')
      .update({ active: false }).eq('household_id', id).eq('tenant_id', TID);

    const { data: hmIds } = await sb.from('household_members')
      .select('id').eq('household_id', id).eq('tenant_id', TID);
    if (hmIds && hmIds.length) {
      await sb.from('member_sessions').delete()
        .in('member_id', hmIds.map((r: { id: string }) => r.id));
    }
    await audit(sb, TID, payload, 'household.delete', 'household', id, `Soft-deleted household ${id}`);
    return jsonResponse({ ok: true });
  }

  // ── add_member ───────────────────────────────────────────────────────
  if (action === 'add_member') {
    const household_id = String(body.household_id ?? '');
    if (!household_id) return jsonResponse({ ok: false, error: 'household_id required' }, 400);

    const { data: hh } = await sb.from('households')
      .select('id').eq('id', household_id).eq('tenant_id', TID).maybeSingle();
    if (!hh) return jsonResponse({ ok: false, error: 'Household not found' }, 404);

    const name = String(body.name ?? '').trim();
    if (!name) return jsonResponse({ ok: false, error: 'Name required' }, 400);
    const role = String(body.role ?? '').trim();
    if (!['adult','teen','child'].includes(role)) {
      return jsonResponse({ ok: false, error: 'Role must be adult, teen, or child' }, 400);
    }

    const phoneRaw = String(body.phone_e164 ?? '').trim();
    let phone: string | null = null;
    if (phoneRaw) {
      phone = normalizePhoneE164(phoneRaw);
      if (!phone) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
    } else if (role !== 'child') {
      return jsonResponse({ ok: false, error: 'Phone required for adults and teens' }, 400);
    }
    if (phone) {
      const { data: clash } = await sb.from('household_members')
        .select('id').eq('tenant_id', TID).eq('phone_e164', phone).eq('active', true).maybeSingle();
      if (clash) return jsonResponse({ ok: false, error: 'Phone number already in use' }, 409);
    }

    const can_unlock_gate  = body.can_unlock_gate  !== false;
    const can_book_parties = body.can_book_parties === true;
    const { data: ins, error: insErr } = await sb.from('household_members').insert({
      tenant_id: TID, household_id, name,
      phone_e164: phone, email: strOrNull(body.email), role,
      can_unlock_gate, can_book_parties, active: true,
      confirmed_at: new Date().toISOString(),
    }).select('id').single();
    if (insErr) {
      const msg = /household_member_cap/.test(insErr.message)
        ? 'Household is at its 8-person limit'
        : insErr.message;
      return jsonResponse({ ok: false, error: msg }, 400);
    }
    return jsonResponse({ ok: true, member_id: ins.id });
  }

  // ── update_member ────────────────────────────────────────────────────
  if (action === 'update_member') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: target } = await sb.from('household_members')
      .select('id, role, phone_e164').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!target) return jsonResponse({ ok: false, error: 'Member not found' }, 404);

    const patch: Record<string, unknown> = {};
    if (body.name !== undefined) {
      const v = String(body.name ?? '').trim();
      if (!v) return jsonResponse({ ok: false, error: 'Name cannot be empty' }, 400);
      patch.name = v;
    }
    if (body.email !== undefined) patch.email = strOrNull(body.email);
    if (body.phone_e164 !== undefined) {
      const raw = String(body.phone_e164 ?? '').trim();
      if (!raw) {
        if (target.role === 'primary') return jsonResponse({ ok: false, error: 'Primary must have a phone' }, 400);
        patch.phone_e164 = null;
      } else {
        const norm = normalizePhoneE164(raw);
        if (!norm) return jsonResponse({ ok: false, error: 'Invalid phone number' }, 400);
        if (norm !== target.phone_e164) {
          const { data: clash } = await sb.from('household_members')
            .select('id').eq('tenant_id', TID).eq('phone_e164', norm)
            .eq('active', true).neq('id', id).maybeSingle();
          if (clash) return jsonResponse({ ok: false, error: 'Phone number already in use' }, 409);
        }
        patch.phone_e164 = norm;
      }
    }
    if (body.role !== undefined && target.role !== 'primary') {
      const r = String(body.role ?? '').trim();
      if (!['adult','teen','child'].includes(r)) {
        return jsonResponse({ ok: false, error: 'Invalid role' }, 400);
      }
      patch.role = r;
    }
    if (body.can_unlock_gate  !== undefined) patch.can_unlock_gate  = !!body.can_unlock_gate;
    if (body.can_book_parties !== undefined) patch.can_book_parties = !!body.can_book_parties;
    if (body.active !== undefined) {
      if (target.role === 'primary' && body.active === false) {
        return jsonResponse({ ok: false, error: 'Deactivate the whole household instead of the primary' }, 400);
      }
      patch.active = !!body.active;
    }
    if (Object.keys(patch).length === 0) return jsonResponse({ ok: true, noop: true });

    const { error } = await sb.from('household_members')
      .update(patch).eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    if (patch.active === false || patch.can_unlock_gate === false) {
      await sb.from('member_sessions').delete().eq('member_id', id);
    }
    return jsonResponse({ ok: true });
  }

  // ── remove_member ────────────────────────────────────────────────────
  if (action === 'remove_member') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);

    const { data: target } = await sb.from('household_members')
      .select('id, role').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!target) return jsonResponse({ ok: false, error: 'Member not found' }, 404);
    if (target.role === 'primary') {
      return jsonResponse({ ok: false, error: "Primary can't be removed — delete the household or transfer primary first" }, 400);
    }
    const { error } = await sb.from('household_members')
      .update({ active: false }).eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('member_sessions').delete().eq('member_id', id);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

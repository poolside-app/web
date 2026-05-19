// =============================================================================
// lifeguards — roster CRUD + shift scheduling + claim/release
// =============================================================================
// Two surfaces sharing one edge function:
//   • Admin (scope='shifts' or owner): manages the roster + builds the schedule
//   • Lifeguard (admin_user with gate_attendant role): claims open shifts,
//     releases their own, sees the team schedule.
//
// Admin actions:
//   list_roster        — all lifeguards, paid + unpaid + inactive flag
//   create_lifeguard   — add a lifeguard to the roster
//   update_lifeguard   — edit name/email/phone/notes/color/certs
//   deactivate         — soft delete (active=false)
//   link_admin_user    — bind an admin_user (login account) to a lifeguard row
//   list_shifts        — schedule rows with assignments, optional date window
//   create_shift       — single shift
//   bulk_create_shifts — create N shifts at once (e.g. recurring template)
//   update_shift       — change time/spots/position/notes
//   cancel_shift       — flip status='cancelled' (keeps audit trail vs delete)
//   assign             — admin-side force-assign a lifeguard to a shift
//   unassign           — admin-side release of a specific signup
//
// Lifeguard actions:
//   my_shifts          — upcoming shifts where I'm signed up
//   open_shifts        — shifts not yet full, within next 30 days
//   team_schedule      — read-only view of who's working when (next 14 days)
//   signup             — claim a spot on an open shift
//   release            — cancel my own signup (frees a spot)
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

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

type Payload = { sub: string; kind: string; tid: string; role_template?: string; scopes?: string[]; is_super?: boolean };
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}
function hasScope(p: Payload, scope: string): boolean {
  if (p.is_super) return true;
  if (p.role_template === 'owner') return true;
  return Array.isArray(p.scopes) && p.scopes.includes(scope);
}
function isAdminLevel(p: Payload): boolean {
  // 'shifts' scope is granted to gate_attendant (the lifeguard role).
  // Admin-level scheduling actions require a HIGHER scope OR owner.
  return p.is_super || p.role_template === 'owner';
}

async function resolveLifeguardId(sb: SupabaseClient, tenantId: string, adminUserId: string): Promise<string | null> {
  const { data } = await sb.from('lifeguards').select('id').eq('tenant_id', tenantId).eq('admin_user_id', adminUserId).maybeSingle();
  return data ? (data.id as string) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST')   return j({ ok: false, error: 'POST only' }, 405);

  const authz = req.headers.get('authorization') || '';
  const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
  const payload = await verifyTenantAdmin(token);
  if (!payload) return j({ ok: false, error: 'Auth required' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const TID = payload.tid;

  // ============== ADMIN ACTIONS (owner / super) ==============

  if (action === 'list_roster') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const { data } = await sb.from('lifeguards')
      .select('id, name, email, phone_e164, color, notes, certifications, admin_user_id, active, created_at')
      .eq('tenant_id', TID).order('active', { ascending: false }).order('name');
    return j({ ok: true, lifeguards: data || [] });
  }

  if (action === 'create_lifeguard') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const name = String(body.name ?? '').trim();
    if (!name) return j({ ok: false, error: 'name required' }, 400);
    const { data, error } = await sb.from('lifeguards').insert({
      tenant_id: TID,
      name,
      email:           (body.email as string)?.trim() || null,
      phone_e164:      (body.phone_e164 as string)?.trim() || null,
      certifications:  body.certifications || null,
      color:           (body.color as string) || '#0a3b5c',
      notes:           (body.notes as string)?.trim() || null,
    }).select('id').single();
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true, id: data.id });
  }

  if (action === 'update_lifeguard') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const id = String(body.id ?? '');
    if (!id) return j({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.name === 'string')           patch.name = body.name.trim();
    if (typeof body.email === 'string')          patch.email = body.email.trim() || null;
    if (typeof body.phone_e164 === 'string')     patch.phone_e164 = body.phone_e164.trim() || null;
    if (typeof body.color === 'string')          patch.color = body.color;
    if (typeof body.notes === 'string')          patch.notes = body.notes.trim() || null;
    if (body.certifications !== undefined)        patch.certifications = body.certifications;
    if (typeof body.active === 'boolean')        patch.active = body.active;
    const { error } = await sb.from('lifeguards').update(patch).eq('id', id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'deactivate') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const id = String(body.id ?? '');
    if (!id) return j({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('lifeguards').update({ active: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'link_admin_user') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const id = String(body.id ?? '');
    const admin_user_id = String(body.admin_user_id ?? '');
    if (!id || !admin_user_id) return j({ ok: false, error: 'id + admin_user_id required' }, 400);
    const { error } = await sb.from('lifeguards').update({ admin_user_id, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'list_shifts') {
    if (!hasScope(payload, 'shifts') && !isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const fromIso = (body.from as string) || new Date(Date.now() - 7 * 86400_000).toISOString();
    const toIso   = (body.to   as string) || new Date(Date.now() + 60 * 86400_000).toISOString();
    const { data: shifts } = await sb.from('lifeguard_shifts')
      .select('id, starts_at, ends_at, position, spots_needed, notes, status, created_at')
      .eq('tenant_id', TID).gte('starts_at', fromIso).lte('starts_at', toIso)
      .order('starts_at');
    if (!shifts || !shifts.length) return j({ ok: true, shifts: [] });
    const shiftIds = shifts.map(s => s.id);
    const { data: signups } = await sb.from('lifeguard_signups')
      .select('id, shift_id, lifeguard_id, status, signed_up_at')
      .eq('tenant_id', TID).in('shift_id', shiftIds).neq('status', 'released');
    const lgIds = [...new Set((signups || []).map(s => s.lifeguard_id))];
    const { data: lifeguards } = lgIds.length
      ? await sb.from('lifeguards').select('id, name, color, admin_user_id').in('id', lgIds)
      : { data: [] };
    const lgById = new Map((lifeguards || []).map(l => [l.id, l]));
    const signupsByShift = new Map<string, Array<Record<string, unknown>>>();
    (signups || []).forEach(s => {
      const arr = signupsByShift.get(s.shift_id as string) || [];
      const lg = lgById.get(s.lifeguard_id as string);
      arr.push({ ...s, lifeguard: lg || { id: s.lifeguard_id, name: '(unknown)' } });
      signupsByShift.set(s.shift_id as string, arr);
    });
    const enriched = shifts.map(s => ({
      ...s,
      signups: signupsByShift.get(s.id) || [],
      spots_filled: (signupsByShift.get(s.id) || []).length,
    }));
    return j({ ok: true, shifts: enriched });
  }

  if (action === 'create_shift') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const starts_at = String(body.starts_at ?? '');
    const ends_at   = String(body.ends_at ?? '');
    if (!starts_at || !ends_at) return j({ ok: false, error: 'starts_at + ends_at required' }, 400);
    const { data, error } = await sb.from('lifeguard_shifts').insert({
      tenant_id: TID,
      starts_at, ends_at,
      position:     (body.position as string) || 'Lifeguard',
      spots_needed: Math.max(1, Math.min(10, Number(body.spots_needed ?? 1))),
      notes:        (body.notes as string)?.trim() || null,
      created_by:   payload.sub,
    }).select('id').single();
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true, id: data.id });
  }

  if (action === 'bulk_create_shifts') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
    if (!items.length) return j({ ok: false, error: 'items required' }, 400);
    const rows = items.map(it => ({
      tenant_id: TID,
      starts_at: String(it.starts_at),
      ends_at:   String(it.ends_at),
      position:     (it.position as string) || 'Lifeguard',
      spots_needed: Math.max(1, Math.min(10, Number(it.spots_needed ?? 1))),
      notes:        (it.notes as string) || null,
      created_by:   payload.sub,
    }));
    const { data, error } = await sb.from('lifeguard_shifts').insert(rows).select('id');
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true, created: (data || []).length });
  }

  if (action === 'update_shift') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const id = String(body.id ?? '');
    if (!id) return j({ ok: false, error: 'id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (typeof body.starts_at === 'string')    patch.starts_at = body.starts_at;
    if (typeof body.ends_at === 'string')      patch.ends_at = body.ends_at;
    if (typeof body.position === 'string')     patch.position = body.position;
    if (body.spots_needed !== undefined)        patch.spots_needed = Math.max(1, Math.min(10, Number(body.spots_needed)));
    if (typeof body.notes === 'string')        patch.notes = body.notes.trim() || null;
    const { error } = await sb.from('lifeguard_shifts').update(patch).eq('id', id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'cancel_shift') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const id = String(body.id ?? '');
    if (!id) return j({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('lifeguard_shifts').update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    // Mark all open signups as released so lifeguards know they're off the hook
    await sb.from('lifeguard_signups').update({ status: 'released', released_at: new Date().toISOString() })
      .eq('shift_id', id).eq('tenant_id', TID).neq('status', 'released');
    return j({ ok: true });
  }

  if (action === 'assign') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const shift_id = String(body.shift_id ?? '');
    const lifeguard_id = String(body.lifeguard_id ?? '');
    if (!shift_id || !lifeguard_id) return j({ ok: false, error: 'shift_id + lifeguard_id required' }, 400);
    const { error } = await sb.from('lifeguard_signups').upsert({
      tenant_id: TID, shift_id, lifeguard_id,
      status: 'confirmed', signed_up_at: new Date().toISOString(), released_at: null,
    }, { onConflict: 'shift_id,lifeguard_id' });
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'unassign') {
    if (!isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden' }, 403);
    const id = String(body.signup_id ?? '');
    if (!id) return j({ ok: false, error: 'signup_id required' }, 400);
    const { error } = await sb.from('lifeguard_signups').update({ status: 'released', released_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  // ============== LIFEGUARD ACTIONS (gate_attendant role) ==============

  if (action === 'my_shifts' || action === 'open_shifts' || action === 'team_schedule' || action === 'signup' || action === 'release') {
    if (!hasScope(payload, 'shifts') && !isAdminLevel(payload)) return j({ ok: false, error: 'Forbidden — needs shifts scope' }, 403);
    const lifeguardId = await resolveLifeguardId(sb, TID, payload.sub);
    if (!lifeguardId && (action === 'my_shifts' || action === 'signup' || action === 'release')) {
      return j({ ok: false, error: 'No lifeguard roster entry linked to this admin account. Ask the club to add you to the roster.' }, 400);
    }

    if (action === 'my_shifts') {
      const { data } = await sb.from('lifeguard_signups')
        .select('id, status, signed_up_at, shift:shift_id(id, starts_at, ends_at, position, spots_needed, notes, status)')
        .eq('tenant_id', TID).eq('lifeguard_id', lifeguardId).neq('status', 'released');
      const upcoming = (data || []).filter(s => {
        const shift = s.shift as Record<string, unknown> | null;
        return shift && shift.status !== 'cancelled' && new Date(shift.ends_at as string) > new Date();
      });
      upcoming.sort((a, b) => new Date((a.shift as Record<string, unknown>).starts_at as string).getTime() - new Date((b.shift as Record<string, unknown>).starts_at as string).getTime());
      return j({ ok: true, shifts: upcoming });
    }

    if (action === 'open_shifts') {
      const now = new Date().toISOString();
      const horizon = new Date(Date.now() + 30 * 86400_000).toISOString();
      const { data: shifts } = await sb.from('lifeguard_shifts')
        .select('id, starts_at, ends_at, position, spots_needed, notes')
        .eq('tenant_id', TID).eq('status', 'open').gte('starts_at', now).lte('starts_at', horizon)
        .order('starts_at');
      if (!shifts?.length) return j({ ok: true, shifts: [] });
      const ids = shifts.map(s => s.id);
      const { data: signups } = await sb.from('lifeguard_signups')
        .select('shift_id, lifeguard_id').eq('tenant_id', TID).in('shift_id', ids).neq('status', 'released');
      const filledByShift = new Map<string, number>();
      const meSignedByShift = new Set<string>();
      (signups || []).forEach(s => {
        filledByShift.set(s.shift_id as string, (filledByShift.get(s.shift_id as string) || 0) + 1);
        if (s.lifeguard_id === lifeguardId) meSignedByShift.add(s.shift_id as string);
      });
      const open = shifts.filter(s => {
        const filled = filledByShift.get(s.id) || 0;
        return filled < (s.spots_needed as number) && !meSignedByShift.has(s.id as string);
      }).map(s => ({
        ...s,
        spots_filled: filledByShift.get(s.id) || 0,
      }));
      return j({ ok: true, shifts: open });
    }

    if (action === 'team_schedule') {
      const now = new Date().toISOString();
      const horizon = new Date(Date.now() + 14 * 86400_000).toISOString();
      const { data: shifts } = await sb.from('lifeguard_shifts')
        .select('id, starts_at, ends_at, position, spots_needed, status')
        .eq('tenant_id', TID).gte('starts_at', now).lte('starts_at', horizon)
        .order('starts_at');
      if (!shifts?.length) return j({ ok: true, shifts: [] });
      const ids = shifts.map(s => s.id);
      const { data: signups } = await sb.from('lifeguard_signups')
        .select('shift_id, lifeguard_id').eq('tenant_id', TID).in('shift_id', ids).neq('status', 'released');
      const lgIds = [...new Set((signups || []).map(s => s.lifeguard_id))];
      const { data: lgs } = lgIds.length ? await sb.from('lifeguards').select('id, name, color').in('id', lgIds) : { data: [] };
      const lgById = new Map((lgs || []).map(l => [l.id, l]));
      const byShift = new Map<string, Array<Record<string, unknown>>>();
      (signups || []).forEach(s => {
        const arr = byShift.get(s.shift_id as string) || [];
        arr.push(lgById.get(s.lifeguard_id as string) || { id: s.lifeguard_id, name: '(unknown)' });
        byShift.set(s.shift_id as string, arr);
      });
      return j({ ok: true, shifts: shifts.map(s => ({ ...s, lifeguards: byShift.get(s.id) || [] })) });
    }

    if (action === 'signup') {
      const shift_id = String(body.shift_id ?? '');
      if (!shift_id) return j({ ok: false, error: 'shift_id required' }, 400);
      // Re-check capacity inside the transaction-y sequence
      const { data: shift } = await sb.from('lifeguard_shifts')
        .select('id, spots_needed, status').eq('id', shift_id).eq('tenant_id', TID).maybeSingle();
      if (!shift) return j({ ok: false, error: 'Shift not found' }, 404);
      if (shift.status !== 'open') return j({ ok: false, error: 'Shift is cancelled' }, 409);
      const { count } = await sb.from('lifeguard_signups')
        .select('*', { count: 'exact', head: true })
        .eq('shift_id', shift_id).neq('status', 'released');
      if ((count ?? 0) >= (shift.spots_needed as number)) {
        return j({ ok: false, error: 'Shift is full — someone else just claimed the last spot.' }, 409);
      }
      const { error } = await sb.from('lifeguard_signups').upsert({
        tenant_id: TID, shift_id, lifeguard_id: lifeguardId!,
        status: 'signed_up', signed_up_at: new Date().toISOString(), released_at: null,
      }, { onConflict: 'shift_id,lifeguard_id' });
      if (error) return j({ ok: false, error: error.message }, 500);
      return j({ ok: true });
    }

    if (action === 'release') {
      const shift_id = String(body.shift_id ?? '');
      if (!shift_id) return j({ ok: false, error: 'shift_id required' }, 400);
      const { error } = await sb.from('lifeguard_signups').update({ status: 'released', released_at: new Date().toISOString() })
        .eq('shift_id', shift_id).eq('lifeguard_id', lifeguardId!).eq('tenant_id', TID);
      if (error) return j({ ok: false, error: error.message }, 500);
      return j({ ok: true });
    }
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});

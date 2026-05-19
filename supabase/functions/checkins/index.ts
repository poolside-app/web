// =============================================================================
// checkins — pool-entry check-in for the lifeguard PWA + member pool pass
// =============================================================================
// Scoped to admins holding 'check_in' (gate_attendant role) for the search +
// log actions. The 'list_today' / 'capacity' read-only actions accept any
// tenant_admin so the Insights page can read them too.
//
// Actions:
//   { action: 'search', q }              → households + members matching q,
//                                          with photo + paid status.
//                                          Anyone with 'check_in' scope.
//   { action: 'log_entry', household_id?, member_id?, party_size?,
//                          guest_count?, method?, notes? }
//                                        → inserts a pool_checkins row.
//   { action: 'list_today' }             → most-recent ~100 of today's entries
//   { action: 'capacity' }               → { in_pool_now, today_total } using
//                                          a 90-min window heuristic
//   { action: 'today_summary' }          → counts by method, peak hour
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

  // ── search — used by the lifeguard tablet view as the primary input.
  //    Matches family_name, member names, and last-4-of-phone. Returns
  //    households with attached member list so the lifeguard sees the
  //    whole family in one tap. Paid status from households.dues_paid_for_year.
  if (action === 'search') {
    if (!hasScope(payload, 'check_in')) return j({ ok: false, error: 'Forbidden — needs check_in scope' }, 403);
    const q = String(body.q ?? '').trim();
    let households: Array<Record<string, unknown>> = [];

    if (!q) {
      // Empty query: return recent active households so the page never looks
      // empty when the lifeguard first opens it.
      const { data } = await sb.from('households')
        .select('id, family_name, dues_paid_for_year')
        .eq('tenant_id', TID).eq('active', true).order('family_name').limit(40);
      households = (data || []) as Array<Record<string, unknown>>;
    } else {
      const digits = q.replace(/\D/g, '');
      const isPhoneLike = digits.length >= 3;
      const like = `%${q.replace(/[%_]/g, m => '\\' + m)}%`;

      // Family name match
      const { data: byFamily } = await sb.from('households')
        .select('id, family_name, dues_paid_for_year')
        .eq('tenant_id', TID).eq('active', true)
        .ilike('family_name', like).limit(20);

      // Member name match → resolve back to household
      const { data: memberHits } = await sb.from('household_members')
        .select('household_id')
        .eq('tenant_id', TID).eq('active', true)
        .ilike('name', like).limit(20);

      // Phone tail match (last 4) → resolve back to household
      let phoneHits: Array<{ household_id: string }> = [];
      if (isPhoneLike) {
        const { data } = await sb.from('household_members')
          .select('household_id')
          .eq('tenant_id', TID).eq('active', true)
          .ilike('phone_e164', `%${digits}%`).limit(20);
        phoneHits = (data || []) as Array<{ household_id: string }>;
      }

      const hidSet = new Set<string>();
      (byFamily || []).forEach(h => hidSet.add(h.id as string));
      (memberHits || []).forEach(m => m.household_id && hidSet.add(m.household_id));
      phoneHits.forEach(m => m.household_id && hidSet.add(m.household_id));

      if (hidSet.size > 0) {
        const { data } = await sb.from('households')
          .select('id, family_name, dues_paid_for_year')
          .eq('tenant_id', TID).eq('active', true)
          .in('id', [...hidSet]).limit(40);
        households = (data || []) as Array<Record<string, unknown>>;
      }
    }

    if (households.length === 0) return j({ ok: true, households: [] });

    // Attach members
    const ids = households.map(h => h.id as string);
    const { data: members } = await sb.from('household_members')
      .select('id, household_id, name, role, phone_e164, active')
      .eq('tenant_id', TID).in('household_id', ids).eq('active', true);
    const byHh = new Map<string, Array<Record<string, unknown>>>();
    (members || []).forEach(m => {
      const arr = byHh.get(m.household_id as string) || [];
      arr.push(m);
      byHh.set(m.household_id as string, arr);
    });

    const enriched = households.map(h => ({
      ...h,
      members: byHh.get(h.id as string) || [],
    }));
    return j({ ok: true, households: enriched });
  }

  if (action === 'log_entry') {
    if (!hasScope(payload, 'check_in')) return j({ ok: false, error: 'Forbidden — needs check_in scope' }, 403);
    const household_id = (body.household_id as string) || null;
    const member_id    = (body.member_id as string)    || null;
    const party_size   = Math.max(1, Math.min(20, Number(body.party_size  ?? 1)));
    const guest_count  = Math.max(0, Math.min(20, Number(body.guest_count ?? 0)));
    const method       = String(body.method ?? 'lifeguard');
    const notes        = (body.notes as string) || null;
    if (!household_id && !member_id) return j({ ok: false, error: 'household_id or member_id required' }, 400);

    let family_name: string | null = null;
    let member_name: string | null = null;
    if (household_id) {
      const { data } = await sb.from('households').select('family_name').eq('id', household_id).eq('tenant_id', TID).maybeSingle();
      family_name = (data?.family_name as string) || null;
    }
    if (member_id) {
      const { data } = await sb.from('household_members').select('name, household_id').eq('id', member_id).eq('tenant_id', TID).maybeSingle();
      member_name = (data?.name as string) || null;
      if (!family_name && data?.household_id) {
        const { data: h } = await sb.from('households').select('family_name').eq('id', data.household_id).eq('tenant_id', TID).maybeSingle();
        family_name = (h?.family_name as string) || null;
      }
    }

    const { data: row, error } = await sb.from('pool_checkins').insert({
      tenant_id: TID,
      household_id, member_id,
      family_name, member_name,
      party_size, guest_count,
      method,
      checked_in_by: payload.sub,
      notes,
    }).select('id, checked_in_at').single();
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true, id: row.id, checked_in_at: row.checked_in_at });
  }

  if (action === 'list_today') {
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const { data } = await sb.from('pool_checkins')
      .select('id, household_id, member_id, family_name, member_name, party_size, guest_count, method, checked_in_at')
      .eq('tenant_id', TID).gte('checked_in_at', startOfDay.toISOString())
      .order('checked_in_at', { ascending: false }).limit(200);
    return j({ ok: true, entries: data || [] });
  }

  if (action === 'capacity') {
    // Heuristic: assume people stay ~90 min unless they explicitly checked
    // out (we don't track checkout yet). "In pool now" = checkins in last
    // 90 min where the household hasn't been counted twice.
    const since = new Date(Date.now() - 90 * 60_000).toISOString();
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const [{ data: recent }, { count: todayCount }] = await Promise.all([
      sb.from('pool_checkins').select('household_id, party_size, guest_count, checked_in_at')
        .eq('tenant_id', TID).gte('checked_in_at', since).order('checked_in_at', { ascending: false }),
      sb.from('pool_checkins').select('*', { count: 'exact', head: true })
        .eq('tenant_id', TID).gte('checked_in_at', startOfDay.toISOString()),
    ]);
    const seenHh = new Set<string>();
    let in_pool_now = 0;
    (recent || []).forEach(r => {
      const k = (r.household_id as string) || 'anon';
      if (seenHh.has(k)) return;
      seenHh.add(k);
      in_pool_now += Number(r.party_size || 1) + Number(r.guest_count || 0);
    });
    return j({ ok: true, in_pool_now, today_total: todayCount ?? 0 });
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});

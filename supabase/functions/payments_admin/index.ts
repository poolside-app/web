// =============================================================================
// payments_admin — unified "who owes what" view across the tenant
// =============================================================================
// Volunteer treasurers don't think in tables — they think "who hasn't paid".
// This rolls up every unpaid surface (dues, applications, programs, guest
// passes) into one list, with mark-paid actions that target the right table.
//
// Actions:
//   { action: 'list' }
//     → { ok, items: [{ kind, id, household_id, family_name, label, amount_cents, age_days, source, source_id }, ...] }
//
//   { action: 'mark_paid', source: 'application'|'program'|'guest_pass'|'dues',
//     source_id: <uuid>, household_id?: <uuid for 'dues'> }
//     → { ok }
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope } from '../_shared/auth.ts';

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
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

function ageDays(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return ms > 0 ? Math.floor(ms / 86400_000) : 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // Scope gate: this function's admin actions require the 'payments' scope.
  // Synthetic webhook tokens bypass; super + owner roles bypass.
  if (!(payload as { synthetic?: boolean }).synthetic && !(await requireScope(createClient(SUPABASE_URL, SERVICE_ROLE), payload as never, 'payments'))) {
    return jsonResponse({ ok: false, error: 'Missing required scope: payments' }, 403);
  }
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'list') {
    // Fetch everything in parallel — none of these depends on the others.
    const [
      { data: dueHouseholds },
      { data: apps },
      { data: progBookings },
      { data: passPacks },
    ] = await Promise.all([
      sb.from('households')
        .select('id, family_name, paid_until_year, decided_at:created_at')
        .eq('tenant_id', TID).eq('active', true).eq('dues_paid_for_year', false),
      sb.from('applications')
        .select('id, family_name, household_id, payment_method, decided_at, created_at')
        .eq('tenant_id', TID).eq('status', 'approved')
        .neq('payment_status', 'paid'),
      sb.from('program_bookings')
        .select('id, household_id, participant_name, program_id, created_at')
        .eq('tenant_id', TID).eq('paid', false).neq('status', 'cancelled'),
      sb.from('guest_pass_packs')
        .select('id, household_id, label, total_count, price_cents, created_at')
        .eq('tenant_id', TID).eq('paid', false).eq('active', true),
    ]);

    // Resolve household + program names in batches
    const hids = new Set<string>();
    (apps ?? []).forEach(a => a.household_id && hids.add(a.household_id));
    (progBookings ?? []).forEach(b => b.household_id && hids.add(b.household_id));
    (passPacks ?? []).forEach(p => hids.add(p.household_id));
    (dueHouseholds ?? []).forEach(h => hids.add(h.id));
    const { data: households } = hids.size
      ? await sb.from('households').select('id, family_name').in('id', [...hids])
      : { data: [] };
    const familyByHid = new Map((households ?? []).map(h => [h.id, h.family_name]));

    const progIds = [...new Set((progBookings ?? []).map(b => b.program_id))];
    const { data: programs } = progIds.length
      ? await sb.from('programs').select('id, name, price_cents').in('id', progIds).eq('tenant_id', TID)
      : { data: [] };
    const progByPid = new Map((programs ?? []).map(p => [p.id, p]));

    const items: Array<Record<string, unknown>> = [];

    // Dedupe: if a household already has an open application-payment item,
    // skip its dues row — both items represent the SAME unpaid year. Verifying
    // the application flips household.dues_paid_for_year=true and clears both
    // naturally. Without this, a self-signing admin sees "Venmo payment
    // pending" + "Dues for 2026" as two distinct line items for one obligation.
    const householdsWithOpenApp = new Set<string>(
      (apps ?? []).map(a => String(a.household_id)).filter(Boolean),
    );

    for (const h of (dueHouseholds ?? [])) {
      if (householdsWithOpenApp.has(h.id)) continue;
      items.push({
        source: 'dues',
        source_id: h.id,
        household_id: h.id,
        family_name: h.family_name,
        kind: 'Annual dues',
        label: `Dues for ${h.paid_until_year ?? new Date().getFullYear()}`,
        amount_cents: null,        // dues amount is set by tier on the household, not here
        age_days: null,
      });
    }

    for (const a of (apps ?? [])) {
      items.push({
        source: 'application',
        source_id: a.id,
        household_id: a.household_id,
        family_name: a.family_name,
        kind: 'Membership application',
        label: `${a.payment_method === 'venmo' ? 'Venmo' : 'Stripe'} payment pending`,
        amount_cents: null,
        age_days: ageDays(a.decided_at ?? a.created_at),
      });
    }

    for (const b of (progBookings ?? [])) {
      const p = progByPid.get(b.program_id);
      items.push({
        source: 'program',
        source_id: b.id,
        household_id: b.household_id,
        family_name: familyByHid.get(b.household_id ?? '') ?? null,
        kind: 'Program signup',
        label: `${p?.name ?? 'Program'} — ${b.participant_name}`,
        amount_cents: p?.price_cents ?? null,
        age_days: ageDays(b.created_at),
      });
    }

    for (const p of (passPacks ?? [])) {
      items.push({
        source: 'guest_pass',
        source_id: p.id,
        household_id: p.household_id,
        family_name: familyByHid.get(p.household_id) ?? null,
        kind: 'Guest passes',
        label: `${p.label} (${p.total_count})`,
        amount_cents: p.price_cents,
        age_days: ageDays(p.created_at),
      });
    }

    // Newest oldest first so the chase-list orders by who's been waiting longest
    items.sort((a, b) => ((b.age_days ?? -1) as number) - ((a.age_days ?? -1) as number));

    return jsonResponse({ ok: true, items });
  }

  if (action === 'mark_paid') {
    const source = String(body.source ?? '');
    const source_id = String(body.source_id ?? '');
    if (!source || !source_id) {
      return jsonResponse({ ok: false, error: 'source and source_id required' }, 400);
    }

    if (source === 'dues') {
      const { error } = await sb.from('households')
        .update({ dues_paid_for_year: true, updated_at: new Date().toISOString() })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      try {
        await sb.from('audit_log').insert({
          tenant_id: TID, kind: 'dues.marked_paid', entity_type: 'household', entity_id: source_id,
          summary: 'Admin marked annual dues paid',
          actor_id: payload.sub, actor_kind: 'tenant_admin',
        });
      } catch { /* ignore */ }
      return jsonResponse({ ok: true });
    }

    if (source === 'application') {
      const { error } = await sb.from('applications')
        .update({
          payment_status: 'paid',
          paid_at: new Date().toISOString(),
          verified_at: new Date().toISOString(),
          verified_by: payload.sub,
        })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      // Application.verify_payment also flips household.dues_paid_for_year — replicate that here
      const { data: app } = await sb.from('applications').select('household_id')
        .eq('id', source_id).maybeSingle();
      if (app?.household_id) {
        await sb.from('households')
          .update({ dues_paid_for_year: true })
          .eq('id', app.household_id).eq('tenant_id', TID);
      }
      return jsonResponse({ ok: true });
    }

    if (source === 'program') {
      const { error } = await sb.from('program_bookings')
        .update({ paid: true, updated_at: new Date().toISOString() })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    if (source === 'guest_pass') {
      const { error } = await sb.from('guest_pass_packs')
        .update({ paid: true, updated_at: new Date().toISOString() })
        .eq('id', source_id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true });
    }

    return jsonResponse({ ok: false, error: `Unknown source: ${source}` }, 400);
  }

  // Bulk version of mark_paid — accepts an array of { source, source_id,
  // household_id? } and processes each independently. One round-trip from
  // the bulk-verify queue view; per-item failures don't roll the others
  // back, but every failure is reported so the admin can re-try.
  if (action === 'bulk_mark_paid') {
    const items = Array.isArray(body.items) ? (body.items as Array<{ source: string; source_id: string; household_id?: string }>) : [];
    if (!items.length) return jsonResponse({ ok: false, error: 'items required' }, 400);

    const ok: string[] = [];
    const failed: Array<{ source_id: string; error: string }> = [];
    for (const it of items) {
      try {
        if (it.source === 'dues') {
          const { error } = await sb.from('households').update({ dues_paid_for_year: true, updated_at: new Date().toISOString() })
            .eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
        } else if (it.source === 'application') {
          const { error } = await sb.from('applications').update({
            payment_status: 'paid', paid_at: new Date().toISOString(),
            verified_at: new Date().toISOString(), verified_by: payload.sub,
          }).eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
          const { data: app } = await sb.from('applications').select('household_id').eq('id', it.source_id).maybeSingle();
          if (app?.household_id) {
            await sb.from('households').update({ dues_paid_for_year: true }).eq('id', app.household_id).eq('tenant_id', TID);
          }
        } else if (it.source === 'program') {
          const { error } = await sb.from('program_bookings').update({ paid: true, updated_at: new Date().toISOString() })
            .eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
        } else if (it.source === 'guest_pass') {
          const { error } = await sb.from('guest_pass_packs').update({ paid: true, updated_at: new Date().toISOString() })
            .eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
        } else if (it.source === 'party') {
          const { error } = await sb.from('party_bookings').update({
            payment_status: 'paid', paid_at: new Date().toISOString(),
            verified_at: new Date().toISOString(), verified_by: payload.sub,
          }).eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
        } else {
          throw new Error(`Unknown source: ${it.source}`);
        }
        ok.push(it.source_id);
      } catch (e) {
        failed.push({ source_id: it.source_id, error: (e as Error).message });
      }
    }
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'payments.bulk_verify',
        entity_type: 'tenant', entity_id: TID,
        summary: `Bulk-verified ${ok.length} offline payment${ok.length === 1 ? '' : 's'}${failed.length ? `, ${failed.length} failed` : ''}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* audit failure non-fatal */ }
    return jsonResponse({ ok: true, verified: ok.length, failed: failed.length, failures: failed });
  }

  // ── Late fees ────────────────────────────────────────────────────────
  // Off for every club until a board explicitly turns it on. See the
  // migration header: the guarantees that make this defensible are that it
  // is opt-in, once per household per season, and waivable in one click by
  // anyone with the payments scope, with no approval step.

  if (action === 'late_fee_config') {
    const { data: t } = await sb.from('tenants')
      .select('late_fee_enabled, late_fee_cents, late_fee_grace_days, dues_due_date')
      .eq('id', TID).maybeSingle();
    return jsonResponse({ ok: true, config: t ?? null });
  }

  if (action === 'set_late_fee_config') {
    const patch: Record<string, unknown> = {};

    if (body.late_fee_enabled !== undefined) {
      patch.late_fee_enabled = !!body.late_fee_enabled;
    }
    if (body.late_fee_cents !== undefined) {
      const n = Number(body.late_fee_cents);
      if (!Number.isFinite(n) || n < 0 || n > 20000) {
        return jsonResponse({ ok: false, error: 'A late fee has to be between $0 and $200.' }, 400);
      }
      patch.late_fee_cents = Math.trunc(n);
    }
    if (body.late_fee_grace_days !== undefined) {
      const n = Number(body.late_fee_grace_days);
      if (!Number.isFinite(n) || n < 0 || n > 180) {
        return jsonResponse({ ok: false, error: 'Grace period has to be between 0 and 180 days.' }, 400);
      }
      patch.late_fee_grace_days = Math.trunc(n);
    }
    if (body.dues_due_date !== undefined) {
      const raw = String(body.dues_due_date ?? '').trim();
      if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        return jsonResponse({ ok: false, error: 'Due date must look like 2027-05-01.' }, 400);
      }
      patch.dues_due_date = raw || null;
    }
    if (!Object.keys(patch).length) return jsonResponse({ ok: false, error: 'Nothing to change' }, 400);

    // Turning it ON without a due date would arm a job that can never fire,
    // and the club would believe late fees were running. Refuse instead.
    if (patch.late_fee_enabled === true) {
      const { data: cur } = await sb.from('tenants').select('dues_due_date').eq('id', TID).maybeSingle();
      const willHave = patch.dues_due_date !== undefined ? patch.dues_due_date : cur?.dues_due_date;
      if (!willHave) {
        return jsonResponse({ ok: false, error: 'Set the date dues are due before switching late fees on — otherwise there is nothing to be late against.' }, 400);
      }
    }

    const { error } = await sb.from('tenants').update(patch).eq('id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'payments.late_fee_config',
        entity_type: 'tenant', entity_id: TID,
        summary: patch.late_fee_enabled === true ? 'Late fees switched on'
               : patch.late_fee_enabled === false ? 'Late fees switched off'
               : 'Late fee settings changed',
        actor_id: payload.sub, actor_kind: 'tenant_admin',
        metadata: patch,
      });
    } catch { /* audit failure non-fatal */ }

    return jsonResponse({ ok: true, config: patch });
  }

  if (action === 'list_late_fees') {
    const { data, error } = await sb.from('late_fees')
      .select('*').eq('tenant_id', TID)
      .order('assessed_at', { ascending: false }).limit(500);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    const ids = [...new Set((data ?? []).map(r => r.household_id))];
    type HouseRef = { id: string; family_name: string };
    const { data: houses } = ids.length
      ? await sb.from('households').select('id, family_name').in('id', ids)
      : { data: [] as HouseRef[] };
    const nameById = new Map<string, string>(
      ((houses ?? []) as HouseRef[]).map(h => [h.id, h.family_name]),
    );
    return jsonResponse({
      ok: true,
      late_fees: (data ?? []).map(r => ({ ...r, family_name: nameById.get(r.household_id) ?? null })),
    });
  }

  if (action === 'waive_late_fee') {
    const id = String(body.late_fee_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'late_fee_id required' }, 400);

    // Only an outstanding fee can be waived. Waiving one already paid would
    // need a refund, which is a different conversation and a different button.
    const { data: row, error } = await sb.from('late_fees')
      .update({
        status: 'waived',
        waived_at: new Date().toISOString(),
        waived_by: payload.sub,
        waive_reason: String(body.reason ?? '').slice(0, 500) || null,
      })
      .eq('id', id).eq('tenant_id', TID).eq('status', 'assessed')
      .select('id, household_id, amount_cents').maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!row) return jsonResponse({ ok: false, error: 'That fee is not outstanding — it may already be paid or waived.' }, 409);

    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'payments.late_fee_waived',
        entity_type: 'late_fee', entity_id: row.id,
        summary: `Late fee waived ($${(Number(row.amount_cents) / 100).toFixed(2)})`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
        metadata: { household_id: row.household_id, reason: String(body.reason ?? '') || null },
      });
    } catch { /* audit failure non-fatal */ }

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

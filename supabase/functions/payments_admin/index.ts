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
//   { action: 'mark_paid', source: 'application'|'program'|'dues',
//     source_id: <uuid>, household_id?: <uuid for 'dues'> }
//     → { ok }
//
// Discount codes (H7, Doug 2026-09-26). Early bird is one of these now.
//   { action: 'codes_list' }  → { ok, codes: [{ ..., uses }] }
//   { action: 'code_save', code: { id?, code, label?, amount_cents? | percent_off?,
//       expires_on?, max_uses?, show_on_home?, active? } } → { ok, code }
//   { action: 'code_off', id }  → { ok }   switched off; kept for the record
//
// Venmo to check (PLAN.md BC1, Doug 10/19: "batch approval would be great").
//   { action: 'venmo_waiting' }
//     → { ok, items: [{ kind: 'signup'|'party'|'keyfob', id, ids?, step?, family_name,
//          label, amount_cents, code, claimed, age_days }] }
//   The page confirms each one with its own screen's step, so a batch does
//   exactly what clicking each one would.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope } from '../_shared/auth.ts';
import { normalizeCode } from '../_shared/pricing.ts';

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

// A family on a payment plan pays by card only (PLAN.md AU1, Doug 10/13:
// "payment plans for stripe only... no venmo allowed, even with deposit").
// Their payments are on Upcoming, and nothing here marks them paid.
const PLAN_CARD_ONLY = 'This family is on a payment plan, which is card only. Their payments are on Money → Upcoming.';
// deno-lint-ignore no-explicit-any
async function onCardPlan(sb: any, tid: string, source: string, id: string): Promise<boolean> {
  if (source === 'application') {
    const { data: a } = await sb.from('applications').select('payment_method, payment_status').eq('id', id).eq('tenant_id', tid).maybeSingle();
    return a?.payment_method === 'stripe_plan' && a?.payment_status === 'pending';
  }
  if (source === 'dues') {
    const { count } = await sb.from('payment_plans').select('id', { count: 'exact', head: true })
      .eq('tenant_id', tid).eq('household_id', id).eq('status', 'active');
    return (count ?? 0) > 0;
  }
  return false;
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

  // Run another function's own confirm step as this board member (PLAN.md
  // BG3). A signup's verify_payment sends the family's confirmation, closes
  // the Venmo to-do, unlocks a referral reward and marks the Drive sheet; a
  // party's books the calendar and the party doors. A bare "paid" flag here
  // skipped all of that.
  const forward = async (fn: string, b: Record<string, unknown>): Promise<{ ok?: boolean; error?: string }> => {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: authHdr }, body: JSON.stringify(b),
    });
    return await r.json().catch(() => ({ ok: false, error: `${fn} answered ${r.status}` }));
  };
  const appMethod = async (id: string): Promise<string> => {
    const { data } = await sb.from('applications').select('payment_method').eq('id', id).eq('tenant_id', TID).maybeSingle();
    const m = String(data?.payment_method ?? '');
    return ['venmo', 'check', 'cash', 'paypal'].includes(m) ? m : 'venmo';
  };

  if (action === 'list') {
    // The current season (PLAN.md U2): a family owes dues for it only if
    // they're a member for it but haven't paid. Families who didn't renew
    // aren't open balances; the Renewals screen is for them.
    const { data: svRow } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const { sellingYear } = await import('../_shared/membership_year.ts');
    const season = sellingYear(svRow?.value ?? {});
    // Fetch everything in parallel — none of these depends on the others.
    const [
      { data: dueHouseholds },
      { data: apps },
      { data: progBookings },
    ] = await Promise.all([
      sb.from('households')
        .select('id, family_name, paid_until_year, decided_at:created_at')
        .eq('tenant_id', TID).eq('active', true).eq('dues_paid_for_year', false).gte('paid_until_year', season),
      sb.from('applications')
        .select('id, family_name, household_id, payment_method, decided_at, created_at, amount_due_cents')
        .eq('tenant_id', TID).eq('status', 'approved')
        // 'pending' is a family on a payment plan; its payments are on Upcoming (PLAN.md AT2).
        .not('payment_status', 'in', '("paid","pending")'),
      sb.from('program_bookings')
        .select('id, household_id, participant_name, program_id, created_at')
        .eq('tenant_id', TID).eq('paid', false).neq('status', 'cancelled'),
    ]);

    // Resolve household + program names in batches
    const hids = new Set<string>();
    (apps ?? []).forEach(a => a.household_id && hids.add(a.household_id));
    (progBookings ?? []).forEach(b => b.household_id && hids.add(b.household_id));
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
    // Families paying on a plan: their dues come in by card on Upcoming (AU1).
    const { data: planRows } = await sb.from('payment_plans').select('household_id')
      .eq('tenant_id', TID).eq('status', 'active').not('household_id', 'is', null).limit(5000);
    const planHouseholds = new Set<string>((planRows ?? []).map(p => String(p.household_id)));

    for (const h of (dueHouseholds ?? [])) {
      if (householdsWithOpenApp.has(h.id) || planHouseholds.has(h.id)) continue;
      items.push({
        source: 'dues',
        source_id: h.id,
        household_id: h.id,
        family_name: h.family_name,
        kind: 'Annual dues',
        label: `Dues for ${season}`,
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
        label: `${({ venmo: 'Venmo', stripe: 'Card', check: 'Check', cash: 'Cash' } as Record<string, string>)[a.payment_method as string] ?? 'Dues'} payment pending`,
        // What they owe after any discount (H5).
        amount_cents: typeof a.amount_due_cents === 'number' ? a.amount_due_cents : null,
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

    // Newest oldest first so the chase-list orders by who's been waiting longest
    items.sort((a, b) => ((b.age_days ?? -1) as number) - ((a.age_days ?? -1) as number));

    return jsonResponse({ ok: true, items });
  }

  if (action === 'venmo_waiting') {
    const [{ data: apps }, { data: parties }, { data: fobs }] = await Promise.all([
      sb.from('applications')
        .select('id, family_name, primary_name, status, payment_status, amount_due_cents, venmo_code, membership_year, created_at, decided_at')
        .eq('tenant_id', TID).eq('payment_method', 'venmo').in('status', ['pending', 'approved'])
        .not('payment_status', 'eq', 'paid').order('created_at').limit(500),
      sb.from('party_bookings')
        .select('id, household_id, title, starts_at, price_cents, payment_status, venmo_code, decided_at')
        .eq('tenant_id', TID).eq('status', 'approved').gt('price_cents', 0)
        .or('payment_status.is.null,payment_status.in.(unpaid,pending_verify)').order('starts_at').limit(500),
      // A fob is only confirmed once the family says they sent it.
      sb.from('keyfobs')
        .select('id, household_id, reason, price_cents, venmo_code, requested_at')
        .eq('tenant_id', TID).eq('payment_status', 'pending_verify').order('requested_at').limit(500),
    ]);
    const hids = [...new Set([...(parties ?? []), ...(fobs ?? [])].map(r => r.household_id).filter(Boolean))];
    const { data: hh } = hids.length ? await sb.from('households').select('id, family_name').in('id', hids) : { data: [] };
    const fam = new Map((hh ?? []).map(h => [h.id, h.family_name]));

    // Signups the family says they paid: an open "I paid via Venmo" task.
    const appIds = (apps ?? []).map(a => a.id);
    const { data: claims } = appIds.length ? await sb.from('admin_tasks').select('source_id')
      .eq('tenant_id', TID).eq('source_kind', 'application').eq('kind', 'venmo.claim').in('source_id', appIds)
      .is('completed_at', null).is('dismissed_at', null) : { data: [] };
    const claimedApps = new Set((claims ?? []).map(c => c.source_id));

    const items: Array<Record<string, unknown>> = [];
    for (const a of (apps ?? [])) {
      items.push({
        kind: 'signup', id: a.id,
        // A new signup is approved and paid in one step; an approved one is only marked paid.
        step: a.status === 'pending' ? 'approve' : 'verify',
        family_name: a.family_name || a.primary_name,
        label: a.status === 'pending' ? `New signup, ${a.membership_year ?? ''} dues`.replace(' ,', ',') : `${a.membership_year ?? ''} dues`.trim(),
        amount_cents: typeof a.amount_due_cents === 'number' ? a.amount_due_cents : null,
        code: a.venmo_code ?? null,
        claimed: claimedApps.has(a.id),
        age_days: ageDays(a.created_at),
      });
    }
    for (const b of (parties ?? [])) {
      items.push({
        kind: 'party', id: b.id,
        family_name: fam.get(b.household_id) ?? null,
        label: `Party: ${b.title || 'party'}`,
        amount_cents: b.price_cents,
        code: b.venmo_code ?? null,
        claimed: b.payment_status === 'pending_verify',
        age_days: ageDays(b.decided_at),
      });
    }
    // One Venmo pays for all of a family's fobs, so they're one line.
    const byFamily = new Map<string, Array<Record<string, unknown>>>();
    for (const f of (fobs ?? [])) {
      const k = String(f.household_id);
      byFamily.set(k, [...(byFamily.get(k) ?? []), f]);
    }
    for (const [hid, list] of byFamily) {
      items.push({
        kind: 'keyfob', id: list[0].id, ids: list.map(f => f.id),
        family_name: fam.get(hid) ?? null,
        label: list.length === 1 ? (list[0].reason === 'replacement' ? 'Replacement keyfob' : 'Keyfob') : `${list.length} keyfobs`,
        amount_cents: list.reduce((n, f) => n + Number(f.price_cents || 0), 0),
        code: list.map(f => f.venmo_code).filter(Boolean).join(' #') || null,
        claimed: true,
        age_days: ageDays(list[0].requested_at as string),
      });
    }
    // The ones the family says they sent first, then the longest waiting.
    items.sort((a, b) => Number(b.claimed) - Number(a.claimed) || ((b.age_days ?? -1) as number) - ((a.age_days ?? -1) as number));
    return jsonResponse({ ok: true, items });
  }

  if (action === 'mark_paid') {
    const source = String(body.source ?? '');
    const source_id = String(body.source_id ?? '');
    if (!source || !source_id) {
      return jsonResponse({ ok: false, error: 'source and source_id required' }, 400);
    }

    if (await onCardPlan(sb, TID, source, source_id)) return jsonResponse({ ok: false, error: PLAN_CARD_ONLY }, 409);

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
      const r = await forward('applications', { action: 'verify_payment', id: source_id, method: await appMethod(source_id) });
      if (!r.ok) return jsonResponse({ ok: false, error: r.error || 'Could not confirm the payment' }, 409);
      return jsonResponse({ ok: true });
    }

    if (source === 'program') {
      const { error } = await sb.from('program_bookings')
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
        if (await onCardPlan(sb, TID, it.source, it.source_id)) throw new Error(PLAN_CARD_ONLY);
        if (it.source === 'dues') {
          const { error } = await sb.from('households').update({ dues_paid_for_year: true, updated_at: new Date().toISOString() })
            .eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
        } else if (it.source === 'application') {
          const r = await forward('applications', { action: 'verify_payment', id: it.source_id, method: await appMethod(it.source_id) });
          if (!r.ok) throw new Error(r.error || 'Could not confirm the payment');
        } else if (it.source === 'program') {
          const { error } = await sb.from('program_bookings').update({ paid: true, updated_at: new Date().toISOString() })
            .eq('id', it.source_id).eq('tenant_id', TID);
          if (error) throw new Error(error.message);
        } else if (it.source === 'party') {
          const r = await forward('parties_admin', { action: 'verify_payment', id: it.source_id, method: 'venmo' });
          if (!r.ok) throw new Error(r.error || 'Could not confirm the party');
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

  // ── Discount codes (H7) ──────────────────────────────────────────────
  if (action === 'codes_list') {
    const { data: codes, error } = await sb.from('discount_codes')
      .select('id, code, label, amount_cents, percent_off, expires_on, max_uses, show_on_home, active, created_at')
      .eq('tenant_id', TID).order('active', { ascending: false }).order('created_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Families who paid with each code.
    const ids = (codes ?? []).map(c => c.id);
    const uses = new Map<string, number>();
    if (ids.length) {
      const { data: used } = await sb.from('applications').select('discount_code_id')
        .in('discount_code_id', ids).not('discount_recorded_at', 'is', null);
      for (const u of used ?? []) uses.set(u.discount_code_id as string, (uses.get(u.discount_code_id as string) ?? 0) + 1);
    }
    return jsonResponse({ ok: true, codes: (codes ?? []).map(c => ({ ...c, uses: uses.get(c.id) ?? 0 })) });
  }

  if (action === 'code_save') {
    const c = (body.code ?? {}) as Record<string, unknown>;
    const code = normalizeCode(c.code);
    if (code.length < 2) return jsonResponse({ ok: false, error: 'A code needs at least 2 letters or numbers.' }, 400);
    const amount = c.amount_cents != null && c.amount_cents !== '' ? Math.round(Number(c.amount_cents)) : null;
    const pct = c.percent_off != null && c.percent_off !== '' ? Number(c.percent_off) : null;
    if ((amount == null) === (pct == null)) return jsonResponse({ ok: false, error: 'Give either a dollar amount or a percent off.' }, 400);
    if (amount != null && !(amount > 0)) return jsonResponse({ ok: false, error: 'The dollar amount has to be more than $0.' }, 400);
    if (pct != null && !(pct > 0 && pct <= 100)) return jsonResponse({ ok: false, error: 'The percent has to be between 1 and 100.' }, 400);
    const expires = c.expires_on ? String(c.expires_on).slice(0, 10) : null;
    if (expires && !/^\d{4}-\d{2}-\d{2}$/.test(expires)) return jsonResponse({ ok: false, error: 'Last day must be a date.' }, 400);
    const maxUses = c.max_uses != null && c.max_uses !== '' ? Math.trunc(Number(c.max_uses)) : null;
    if (maxUses != null && !(maxUses > 0)) return jsonResponse({ ok: false, error: 'The family limit has to be 1 or more, or blank for no limit.' }, 400);
    const row = {
      tenant_id: TID, code,
      label: c.label ? String(c.label).trim().slice(0, 60) || null : null,
      amount_cents: amount, percent_off: pct, expires_on: expires, max_uses: maxUses,
      show_on_home: c.show_on_home === true, active: c.active !== false,
      updated_at: new Date().toISOString(),
    };
    const q = c.id
      ? sb.from('discount_codes').update(row).eq('id', String(c.id)).eq('tenant_id', TID)
      : sb.from('discount_codes').insert({ ...row, created_by: payload.sub });
    const { data, error } = await q.select('id, code, label, amount_cents, percent_off, expires_on, max_uses, show_on_home, active').maybeSingle();
    if (error) {
      return jsonResponse({ ok: false, error: /duplicate|unique/i.test(error.message) ? `There's already a code ${code}.` : error.message }, 400);
    }
    if (!data) return jsonResponse({ ok: false, error: 'Code not found' }, 404);
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: c.id ? 'discount_code.updated' : 'discount_code.created',
        entity_type: 'discount_code', entity_id: data.id,
        summary: `${c.id ? 'Changed' : 'Made'} discount code ${code}: ${amount != null ? '$' + (amount / 100).toFixed(2) : pct + '%'} off${expires ? ' until ' + expires : ''}${maxUses ? ', up to ' + maxUses + ' families' : ''}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* the code saved; the log line is secondary */ }
    return jsonResponse({ ok: true, code: data });
  }

  if (action === 'code_off') {
    // Switched off, not deleted: payments made with it still point at it.
    const id = String(body.id ?? '');
    const { data, error } = await sb.from('discount_codes')
      .update({ active: false, show_on_home: false, updated_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID).select('code').maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!data) return jsonResponse({ ok: false, error: 'Code not found' }, 404);
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind: 'discount_code.switched_off', entity_type: 'discount_code', entity_id: id,
        summary: `Switched off discount code ${data.code}`, actor_id: payload.sub, actor_kind: 'tenant_admin',
      });
    } catch { /* non-fatal */ }
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

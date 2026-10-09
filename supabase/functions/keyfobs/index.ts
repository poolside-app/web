// =============================================================================
// keyfobs — families' keyfobs and the board's keyfob desk (PLAN.md P)
// =============================================================================
// Doug, 2026-10-08: a new family gets the club's included fob (1 at Bishop);
// another fob, or a replacement for a lost one, costs the club's fee ($15)
// and is paid in the app before the board issues it. A lost fob is flagged
// to be turned off right away. The board issues a fob by typing the number
// printed on it. Switching fobs on and off at the gate panel comes later
// (P5); until then the board does that at the panel and marks it here.
//
// Member actions (member JWT):
//   { action: 'mine' }                          → { ok, enabled, fobs, fee_cents, card_total_cents }
//   { action: 'request', count? }               → { ok, fobs }  more fobs, at the fee, up to the family limit
//   { action: 'report_lost', id, replace? }     → { ok, replacement? }
//   { action: 'claim_venmo', ids }              → { ok }        "I paid by Venmo" for the unpaid ones
//   { action: 'cancel', ids }                   → { ok, count } a request not paid yet (PLAN.md X2)
//
// Board actions (tenant admin; the keyfobs or households screen):
//   { action: 'list' }                          → { ok, fobs, households, settings }
//   { action: 'issue', id, number }             → { ok, fob }   either printed format
//   { action: 'add', household_id, number, member_id? } → { ok, fob }   a fob they already have
//   { action: 'turned_off', id }                → { ok }        done at the panel
//   { action: 'require_payment', id }           → { ok }        a flagged free fob: charge instead
//   { action: 'cancel', id }                    → { ok }        a request not paid yet; the family gets a pop-up
//   { action: 'confirm_venmo', id }             → { ok }
//   { action: 'swap', id, number?, charge? }    → { ok }        a broken fob: a free one now, or $15 first (PLAN.md Q5)
//   { action: 'settings_get' } / { action: 'settings_save', included_free?, fee_cents?, max_per_family? }
// Card payments go through stripe_checkout ('keyfob') and stripe_webhook.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireScope, type AdminPayload } from '../_shared/auth.ts';
import { fobSettings, parseFobNumber, fobTail, fobCardTotal, syncHouseholdFobs, liveFobCount, canCancel } from '../_shared/keyfobs.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const j = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });

const FIELDS = 'id, household_id, member_id, card_number, status, reason, included, price_cents, payment_status, payment_method, replaces_id, check_note, requested_at, issued_at, lost_at, turned_off_at, paid_at';
type Sb = ReturnType<typeof createClient>;

async function claims(token: string): Promise<Record<string, unknown> | null> {
  if (!JWT_SECRET || !token) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    return await verify(token, key) as Record<string, unknown>;
  } catch { return null; }
}

/** The board member may use the keyfob desk: full access, or the keyfobs or
 *  households screen (_shared/auth.ts reads it from the database). */
async function boardCaller(sb: Sb, p: Record<string, unknown>): Promise<{ id: string; name: string } | null> {
  const a = p as unknown as AdminPayload;
  if (!(await requireScope(sb, a, 'keyfobs')) && !(await requireScope(sb, a, 'households'))) return null;
  const { data } = await sb.from('admin_users').select('display_name').eq('id', a.sub).maybeSingle();
  return { id: a.sub, name: (data?.display_name as string) || 'The board' };
}

const shape = (f: Record<string, unknown>) => ({ ...f, card_number: f.card_number == null ? null : Number(f.card_number), tail: fobTail(f.card_number as number | null) });

async function task(sb: Sb, tenantId: string, kind: string, fobId: string, summary: string, push: string) {
  const { enqueueAdminTask } = await import('../_shared/enqueue_task.ts');
  await enqueueAdminTask(sb, {
    tenant_id: tenantId, target_scopes: ['keyfobs'], kind, summary,
    link_url: '/club/admin/keyfobs.html', source_kind: 'keyfob', source_id: fobId,
    push_title: '🔑 ' + push, push_body: summary,
  });
}
async function closeTasks(sb: Sb, fobId: string, by: string | null, householdId?: string) {
  const now = new Date().toISOString();
  await sb.from('admin_tasks').update({ completed_at: now, completed_by: by })
    .eq('source_kind', 'keyfob').eq('source_id', fobId).is('completed_at', null);
  // The one task for a family's fobs at approval (PLAN.md Q4) closes when
  // none of them are left to issue.
  if (householdId) {
    const { data: left } = await sb.from('keyfobs').select('id, included, payment_status')
      .eq('household_id', householdId).eq('status', 'requested');
    if (!(left ?? []).some(f => f.included || f.payment_status === 'paid' || f.payment_status === 'none')) {
      await sb.from('admin_tasks').update({ completed_at: now, completed_by: by })
        .eq('source_kind', 'keyfob_household').eq('source_id', householdId).is('completed_at', null);
    }
  }
}
async function popFamily(tenantId: string, householdId: string, title: string, body: string) {
  try {
    const { pushMembers } = await import('../_shared/member_notify.ts');
    await pushMembers({ tenant_id: tenantId, household_ids: [householdId], title, body, url: '/m/#keyfobs', tag: 'keyfob' });
  } catch { /* the app shows it either way */ }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return j({ ok: false, error: 'POST required' }, 405);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const auth = req.headers.get('authorization') || '';
  const p = await claims(auth.startsWith('Bearer ') ? auth.slice(7) : '');
  if (!p || !p.sub || !p.tid) return j({ ok: false, error: 'Not authenticated' }, 401);
  const TID = String(p.tid);
  const { data: setRow } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
  const settings = fobSettings(setRow?.value);
  const pay = ((setRow?.value as Record<string, unknown> | undefined)?.payments as Record<string, unknown> | undefined) ?? {};
  const cardTotal = (c: number) => fobCardTotal(c, Number(pay.stripe_pct ?? 2.9) / 100, Number(pay.stripe_fixed_cents ?? 30));

  // ═══ The family ═════════════════════════════════════════════════════════
  if (p.kind === 'member') {
    const hid = String(p.hid ?? '');
    if (!hid) return j({ ok: false, error: 'Not authenticated' }, 401);
    if (!settings.enabled) return j({ ok: true, enabled: false, fobs: [] });
    const { data: hh } = await sb.from('households').select('id, family_name').eq('id', hid).eq('tenant_id', TID).maybeSingle();
    if (!hh) return j({ ok: false, error: 'Household not found' }, 404);
    const own = async (id: unknown) => {
      const { data } = await sb.from('keyfobs').select(FIELDS).eq('id', String(id ?? '')).eq('household_id', hid).maybeSingle();
      return data as Record<string, unknown> | null;
    };

    if (action === 'mine') {
      const { data } = await sb.from('keyfobs').select(FIELDS).eq('household_id', hid).neq('status', 'off').order('requested_at');
      const live = (data ?? []).filter(f => f.status === 'requested' || f.status === 'active').length;
      return j({ ok: true, enabled: true, fobs: (data ?? []).map(shape), fee_cents: settings.fee_cents, card_total_cents: cardTotal(settings.fee_cents),
        max_per_family: settings.max_per_family, room: Math.max(0, settings.max_per_family - live) });
    }

    // More fobs (PLAN.md Q5): up to the family limit, counting working fobs
    // and ones on their way. Lost and turned-off fobs don't count.
    if (action === 'request') {
      // Members only (PLAN.md U3).
      const { householdStatus, NOT_A_MEMBER } = await import('../_shared/membership_status.ts');
      const st = await householdStatus(sb as never, TID, hid);
      if (!st.member) return j({ ok: false, code: 'not_member', error: NOT_A_MEMBER(st.season) }, 403);
      const want = Math.trunc(Number(body.count ?? 1));
      if (!Number.isFinite(want) || want < 1) return j({ ok: false, error: 'How many fobs?' }, 400);
      const room = settings.max_per_family - await liveFobCount(sb, hid);
      if (want > room) {
        return j({ ok: false, error: room <= 0
          ? `You have ${settings.max_per_family} fobs already, the most a family can have. Report a lost one to replace it.`
          : `You can add ${room} more (${settings.max_per_family} per family).` }, 409);
      }
      const free = settings.fee_cents <= 0;
      const rows = Array.from({ length: want }, () => ({
        tenant_id: TID, household_id: hid, member_id: body.member_id ? String(body.member_id) : null,
        status: 'requested', reason: 'extra', included: false, price_cents: settings.fee_cents,
        payment_status: free ? 'none' : 'unpaid',
      }));
      const { data, error } = await sb.from('keyfobs').insert(rows).select(FIELDS);
      if (error || !data?.length) return j({ ok: false, error: error?.message || 'Could not request fobs' }, 500);
      if (free) for (const f of data) await task(sb, TID, 'keyfob.issue', f.id as string, `Issue another keyfob to the ${hh.family_name}`, 'Keyfob to issue');
      return j({ ok: true, fobs: data.map(shape), fob: shape(data[0]), card_total_cents: cardTotal(settings.fee_cents * want) });
    }

    if (action === 'report_lost') {
      const f = await own(body.id);
      if (!f || f.status !== 'active') return j({ ok: false, error: 'That fob isn\'t active.' }, 404);
      const now = new Date().toISOString();
      await sb.from('keyfobs').update({ status: 'lost', lost_at: now }).eq('id', f.id);
      await task(sb, TID, 'keyfob.off', f.id as string, `Turn off the ${hh.family_name}'s keyfob ${fobTail(f.card_number as number)}: reported lost`, 'Lost keyfob: turn it off');
      await syncHouseholdFobs(sb, hid);
      let replacement: Record<string, unknown> | null = null;
      if (body.replace === true) {
        const free = settings.fee_cents <= 0;
        const { data } = await sb.from('keyfobs').insert({
          tenant_id: TID, household_id: hid, member_id: f.member_id ?? null, status: 'requested', reason: 'replacement',
          included: false, price_cents: settings.fee_cents, payment_status: free ? 'none' : 'unpaid', replaces_id: f.id,
        }).select(FIELDS).single();
        replacement = data ? shape(data) : null;
        if (free && data) await task(sb, TID, 'keyfob.issue', data.id as string, `Issue a replacement keyfob to the ${hh.family_name}`, 'Keyfob to issue');
      }
      return j({ ok: true, replacement, card_total_cents: cardTotal(settings.fee_cents) });
    }

    // "I sent it by Venmo" for one or several unpaid fobs (Doug, 10/8,
    // PLAN.md U1): straight to the board to make the fob, one task per fob.
    // The board checks the Venmo arrived when it issues the fob; issuing it
    // marks it paid. No separate confirm step.
    if (action === 'claim_venmo') {
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String).filter(Boolean).slice(0, 20);
      const { data: fobs } = await sb.from('keyfobs').select(FIELDS).eq('household_id', hid).in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']).eq('payment_status', 'unpaid');
      if (!fobs?.length) return j({ ok: false, error: 'Nothing to pay on those fobs.' }, 409);
      const total = fobs.reduce((n, f) => n + Number(f.price_cents), 0);
      await sb.from('keyfobs').update({ payment_status: 'pending_verify', payment_method: 'venmo' }).in('id', fobs.map(f => f.id));
      for (const f of fobs) {
        await task(sb, TID, 'keyfob.issue', f.id as string,
          `Issue ${fobs.length === 1 ? 'a keyfob' : 'keyfobs'} to the ${hh.family_name}: they say they sent $${(total / 100).toFixed(2)} by Venmo. Check it came in before you hand it over.`, 'Keyfob to issue');
      }
      return j({ ok: true, count: fobs.length });
    }
    // Cancel a request before it's paid (PLAN.md X2). It never had a fob
    // number, so it's simply removed.
    if (action === 'cancel') {
      const ids = (Array.isArray(body.ids) ? body.ids : [body.id]).map(String).filter(Boolean).slice(0, 20);
      const { data: fobs } = await sb.from('keyfobs').select(FIELDS).eq('household_id', hid)
        .in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      const ok = (fobs ?? []).filter(f => canCancel(f));
      if (!ok.length) return j({ ok: false, error: 'Only a request that isn\'t paid yet can be canceled. Ask the board through Member help.' }, 409);
      await sb.from('keyfobs').delete().in('id', ok.map(f => f.id));
      for (const f of ok) await closeTasks(sb, f.id as string, null, hid);
      return j({ ok: true, count: ok.length });
    }
    return j({ ok: false, error: `Unknown action: ${action}` }, 400);
  }

  // ═══ The board ══════════════════════════════════════════════════════════
  if (p.kind !== 'tenant_admin') return j({ ok: false, error: 'Not authenticated' }, 401);
  const me = await boardCaller(sb, p);
  if (!me) return j({ ok: false, error: 'The keyfob desk is for the board member who handles keyfobs.' }, 403);
  const one = async (id: unknown) => {
    const { data } = await sb.from('keyfobs').select(FIELDS).eq('id', String(id ?? '')).eq('tenant_id', TID).maybeSingle();
    return data as Record<string, unknown> | null;
  };
  const familyName = async (hid: unknown) => {
    const { data } = await sb.from('households').select('family_name').eq('id', String(hid)).maybeSingle();
    return (data?.family_name as string) || 'the family';
  };
  // A number on a live fob belongs to that fob only.
  const taken = async (num: number, exceptId?: string) => {
    const { data } = await sb.from('keyfobs').select('id, household_id').eq('tenant_id', TID).eq('card_number', num).neq('status', 'off').limit(1);
    const hit = (data ?? []).find(r => r.id !== exceptId);
    return hit ? await familyName(hit.household_id) : null;
  };

  if (action === 'settings_get') return j({ ok: true, ...settings });
  if (action === 'settings_save') {
    const value = (setRow?.value as Record<string, unknown> | undefined) ?? {};
    const k = { ...((value.keyfobs as Record<string, unknown> | undefined) ?? {}) };
    if (body.included_free !== undefined) {
      const n = Number(body.included_free);
      if (!Number.isInteger(n) || n < 0 || n > 6) return j({ ok: false, error: 'Included fobs: 0 to 6.' }, 400);
      k.included_free = n;
    }
    if (body.max_per_family !== undefined) {
      const m = Number(body.max_per_family);
      if (!Number.isInteger(m) || m < 1 || m > 20) return j({ ok: false, error: 'Fobs per family: 1 to 20.' }, 400);
      k.max_per_family = m;
    }
    if (body.fee_cents !== undefined) {
      const c = Number(body.fee_cents);
      if (!Number.isFinite(c) || c < 0 || c > 20000) return j({ ok: false, error: 'Enter the fob fee in dollars.' }, 400);
      k.fee_cents = Math.round(c);
    }
    const next = { ...value, keyfobs: k };
    const { error } = setRow ? await sb.from('settings').update({ value: next }).eq('tenant_id', TID)
      : await sb.from('settings').insert({ tenant_id: TID, value: next });
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true, ...fobSettings(next) });
  }

  if (action === 'list') {
    const [{ data: fobs }, { data: hhs }, { data: people }] = await Promise.all([
      sb.from('keyfobs').select(FIELDS).eq('tenant_id', TID).order('requested_at', { ascending: false }).limit(2000),
      sb.from('households').select('id, family_name, address, active').eq('tenant_id', TID).order('family_name').limit(2000),
      sb.from('household_members').select('id, name, household_id').eq('tenant_id', TID).eq('active', true).limit(5000),
    ]);
    const fam = new Map((hhs ?? []).map(h => [h.id as string, h.family_name as string]));
    const who = new Map((people ?? []).map(m => [m.id as string, m.name as string]));
    return j({
      ok: true, settings,
      fobs: (fobs ?? []).map(f => ({ ...shape(f), family_name: fam.get(f.household_id as string) ?? '', member_name: f.member_id ? who.get(f.member_id as string) ?? null : null })),
      households: (hhs ?? []).filter(h => h.active !== false).map(h => ({ id: h.id, family_name: h.family_name, address: h.address })),
    });
  }

  if (action === 'issue') {
    const f = await one(body.id);
    if (!f || f.status !== 'requested') return j({ ok: false, error: 'That request isn\'t waiting to be issued.' }, 404);
    // A Venmo the family says they sent counts: the board checks it when it
    // hands the fob over, and issuing marks it paid (PLAN.md U1).
    if (!f.included && !['paid', 'none', 'pending_verify'].includes(String(f.payment_status))) {
      return j({ ok: false, error: 'This fob isn\'t paid for yet.' }, 409);
    }
    const parsed = parseFobNumber(body.number);
    if (!parsed.ok) return j({ ok: false, error: parsed.error }, 400);
    const owner = await taken(parsed.number);
    if (owner) return j({ ok: false, error: `Fob ${fobTail(parsed.number)} already belongs to the ${owner}.` }, 409);
    const nowIso = new Date().toISOString();
    const { data, error } = await sb.from('keyfobs').update({
      status: 'active', card_number: parsed.number, issued_at: nowIso, issued_by: me.id,
      ...(f.payment_status === 'pending_verify' ? { payment_status: 'paid', paid_at: nowIso } : {}),
    }).eq('id', f.id).select(FIELDS).single();
    if (error) return j({ ok: false, error: /duplicate|unique/i.test(error.message) ? 'That number is already on another fob.' : error.message }, 409);
    await closeTasks(sb, f.id as string, me.id, f.household_id as string);
    await syncHouseholdFobs(sb, f.household_id as string);
    await popFamily(TID, f.household_id as string, '🔑 Your keyfob is ready', `Fob ${fobTail(parsed.number)} is set up. Pick it up from the board.`);
    return j({ ok: true, fob: shape(data) });
  }

  if (action === 'add') {
    const hid = String(body.household_id ?? '');
    const { data: hh } = await sb.from('households').select('id').eq('id', hid).eq('tenant_id', TID).maybeSingle();
    if (!hh) return j({ ok: false, error: 'Pick a family.' }, 400);
    const parsed = parseFobNumber(body.number);
    if (!parsed.ok) return j({ ok: false, error: parsed.error }, 400);
    const owner = await taken(parsed.number);
    if (owner) return j({ ok: false, error: `Fob ${fobTail(parsed.number)} already belongs to the ${owner}.` }, 409);
    const now = new Date().toISOString();
    const { data, error } = await sb.from('keyfobs').insert({
      tenant_id: TID, household_id: hid, member_id: body.member_id ? String(body.member_id) : null,
      card_number: parsed.number, status: 'active', reason: 'board', issued_at: now, issued_by: me.id,
    }).select(FIELDS).single();
    if (error) return j({ ok: false, error: /duplicate|unique/i.test(error.message) ? 'That number is already on another fob.' : error.message }, 409);
    await syncHouseholdFobs(sb, hid);
    return j({ ok: true, fob: shape(data) });
  }

  if (action === 'turned_off') {
    const f = await one(body.id);
    if (!f || !['active', 'lost'].includes(String(f.status))) return j({ ok: false, error: 'That fob is already off.' }, 409);
    await sb.from('keyfobs').update({ status: 'off', turned_off_at: new Date().toISOString() }).eq('id', f.id);
    await closeTasks(sb, f.id as string, me.id);
    await syncHouseholdFobs(sb, f.household_id as string);
    return j({ ok: true });
  }

  // Cancel a request before it's paid (PLAN.md X2): the family gets a pop-up.
  if (action === 'cancel') {
    const f = await one(body.id);
    if (!f || !canCancel(f)) return j({ ok: false, error: 'Only a request that isn\'t paid yet can be canceled.' }, 409);
    await sb.from('keyfobs').delete().eq('id', f.id);
    await closeTasks(sb, f.id as string, me.id, f.household_id as string);
    await popFamily(TID, f.household_id as string, '🔑 Keyfob request canceled',
      `The board canceled your request for ${f.reason === 'replacement' ? 'a replacement fob' : 'a new fob'}. Ask the board if you still need one.`);
    return j({ ok: true });
  }

  if (action === 'require_payment') {
    const f = await one(body.id);
    if (!f || f.status !== 'requested' || !f.included) return j({ ok: false, error: 'Only a free new-member fob can be switched to paid.' }, 409);
    await sb.from('keyfobs').update({ included: false, price_cents: settings.fee_cents, payment_status: settings.fee_cents > 0 ? 'unpaid' : 'none',
      check_note: `${f.check_note ? f.check_note + ' ' : ''}${me.name} asked for payment instead.` }).eq('id', f.id);
    await closeTasks(sb, f.id as string, me.id, f.household_id as string);
    await popFamily(TID, f.household_id as string, '🔑 Your keyfob',
      `The board asked for the $${(settings.fee_cents / 100).toFixed(2)} fob fee. Pay it in the app and they'll issue your fob.`);
    return j({ ok: true });
  }

  // A broken fob, reported through Member help (Doug, 10/8). Free by
  // default: the old one goes off and the new number is on now. Or the board
  // charges the fee: the old one goes off and the family pays in the app.
  if (action === 'swap') {
    const f = await one(body.id);
    if (!f || f.status !== 'active') return j({ ok: false, error: 'Only a working fob can be swapped.' }, 409);
    const now = new Date().toISOString();
    if (body.charge === true) {
      await sb.from('keyfobs').update({ status: 'off', turned_off_at: now, check_note: `Broken; ${me.name} asked for the fee.` }).eq('id', f.id);
      const free = settings.fee_cents <= 0;
      await sb.from('keyfobs').insert({ tenant_id: TID, household_id: f.household_id, member_id: f.member_id ?? null, status: 'requested',
        reason: 'replacement', included: false, price_cents: settings.fee_cents, payment_status: free ? 'none' : 'unpaid', replaces_id: f.id });
      await syncHouseholdFobs(sb, f.household_id as string);
      await popFamily(TID, f.household_id as string, '🔑 Your new keyfob',
        free ? 'The board will set up a new fob for you.' : `Pay the $${(settings.fee_cents / 100).toFixed(2)} fob fee in the app and the board will set up your new fob.`);
      return j({ ok: true, charged: !free });
    }
    const parsed = parseFobNumber(body.number);
    if (!parsed.ok) return j({ ok: false, error: parsed.error }, 400);
    const owner = await taken(parsed.number, f.id as string);
    if (owner) return j({ ok: false, error: `Fob ${fobTail(parsed.number)} already belongs to the ${owner}.` }, 409);
    await sb.from('keyfobs').update({ status: 'off', turned_off_at: now, check_note: 'Broken; swapped free.' }).eq('id', f.id);
    const { data, error } = await sb.from('keyfobs').insert({ tenant_id: TID, household_id: f.household_id, member_id: f.member_id ?? null,
      card_number: parsed.number, status: 'active', reason: 'replacement', included: false, price_cents: 0, payment_status: 'none',
      replaces_id: f.id, issued_at: now, issued_by: me.id }).select(FIELDS).single();
    if (error) return j({ ok: false, error: /duplicate|unique/i.test(error.message) ? 'That number is already on another fob.' : error.message }, 409);
    await syncHouseholdFobs(sb, f.household_id as string);
    await popFamily(TID, f.household_id as string, '🔑 Your new keyfob is ready', `Fob ${fobTail(parsed.number)} replaces your broken one. Pick it up from the board.`);
    return j({ ok: true, fob: shape(data) });
  }

  if (action === 'confirm_venmo') {
    const f = await one(body.id);
    if (!f || f.payment_status !== 'pending_verify') return j({ ok: false, error: 'No Venmo to confirm on that fob.' }, 409);
    await sb.from('keyfobs').update({ payment_status: 'paid', paid_at: new Date().toISOString() }).eq('id', f.id);
    await closeTasks(sb, f.id as string, me.id);
    await task(sb, TID, 'keyfob.issue', f.id as string, `Issue a keyfob to the ${await familyName(f.household_id)} (paid by Venmo)`, 'Keyfob to issue');
    return j({ ok: true });
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});

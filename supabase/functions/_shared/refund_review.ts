// =============================================================================
// refund_review.ts — the board's choices after a refund or chargeback (PLAN.md BT)
// =============================================================================
// Doug, 11/4: "keep them a member until the board member does something about
// it... make sure that we have proper options on all refunds... so like if we
// refund for a keyfob". Each refund or chargeback on a club's Stripe is one
// to-do (REVIEW_KINDS). Nothing changes until a board member picks one of its
// choices, on Money → Payments → Refunds and chargebacks or in a signup's
// details. Mark done on the to-do keeps things as they are.
//
//   choicesFor        what can be done, from the thing paid for as it is now
//   listReviews       the open ones, ready to show
//   decideReview      do the choice, close the to-do, write it down
//   boardRefundCents  a refund less what Poolside refunded itself (BT7)
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const REVIEW_KINDS = ['application.refund', 'application.dispute', 'payment.refund', 'payment.dispute'];
export const REFUNDS_LINK = '/club/admin/payments.html#refunds';

export type Item = 'membership' | 'keyfobs' | 'party' | 'program' | 'donation' | 'unknown';
export type Choice = { key: string; label: string; hint: string; danger?: boolean };

const PAID_BY: Record<string, string> = { check: 'check', cash: 'cash', venmo: 'Venmo' };
const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const tail = (n: unknown) => (n == null ? null : String(n).slice(-4));

/**
 * The board's part of a refund (BT7). A referral reward is paid back to the
 * member's own card as a refund (referrals, `metadata[poolside_kind]`); that
 * one is Poolside's, not something to decide.
 */
export function boardRefundCents(
  amountRefunded: number,
  refunds: Array<{ amount?: number; metadata?: Record<string, unknown> | null }> | null | undefined,
): number {
  const own = (refunds ?? []).filter(r => !!r?.metadata?.poolside_kind).reduce((n, r) => n + (Number(r.amount) || 0), 0);
  return Math.max(0, (Number(amountRefunded) || 0) - own);
}

type State = Record<string, unknown>;

export function choicesFor(v: { item: string; state: State }): Choice[] {
  const s = v.state ?? {};
  const ok: Choice = { key: 'ok', label: 'OK', hint: 'Nothing to change in Poolside.' };
  switch (v.item) {
    case 'membership': {
      if (!s.member) return [ok];
      const season = s.season ? `${s.season} ` : '';
      return [
        { key: 'keep', label: 'Keep them as members', hint: 'Nothing changes. If they paid another way, say how.' },
        { key: 'end', label: 'End their membership', danger: true,
          hint: `Their ${season}dues go back to unpaid${s.plan_active ? ', their payment plan stops with no more charges' : ''}, each fob in use gets a "turn it off" to-do, and they get a pop-up. Their record stays, so they can join again.` },
      ];
    }
    case 'keyfobs': {
      const fobs = (s.fobs as Array<{ status?: string }> | undefined) ?? [];
      const live = fobs.filter(f => f.status === 'active' || f.status === 'requested');
      if (!live.length) return [ok];
      const many = fobs.length > 1;
      const waiting = live.every(f => f.status === 'requested'), inUse = live.every(f => f.status === 'active');
      return [
        { key: 'fobs_off', danger: true,
          label: many ? 'Turn off the ticked fobs' : waiting ? 'Cancel the fob' : 'Turn the fob off',
          hint: waiting ? `Not handed out yet: the request${many ? 's are' : ' is'} canceled and the family gets a pop-up.`
            : inUse ? 'The keyfob person gets a to-do to turn it off.'
            : 'A fob in use gets a "turn it off" to-do; one not handed out yet is canceled, with a pop-up.' },
        { key: 'keep', label: many ? 'Keep them' : 'Keep the fob', hint: 'Nothing changes.' },
      ];
    }
    case 'party':
      if (['cancelled', 'rejected'].includes(String(s.status))) return [ok];
      return [
        { key: 'cancel_party', label: 'Cancel the party', danger: true, hint: 'It comes off the calendar, its party doors end, and the family gets a pop-up.' },
        { key: 'keep', label: 'Keep the party', hint: 'Nothing changes.' },
      ];
    case 'program':
      if (s.status === 'cancelled') return [ok];
      return [
        { key: 'cancel_booking', label: `Take them off ${s.program ?? 'the program'}`, danger: true, hint: 'Their place is given up.' },
        { key: 'keep', label: 'Keep them on it', hint: 'Nothing changes.' },
      ];
    case 'donation':
      if (s.status === 'refunded') return [ok];
      return [
        { key: 'off_total', label: 'Take it off the fundraiser', danger: true, hint: 'The fundraiser total goes down by what was refunded.' },
        { key: 'keep', label: 'Leave it on', hint: 'Nothing changes.' },
      ];
  }
  return [{ key: 'ok', label: 'OK', hint: 'Poolside couldn\'t tell what this paid for. Look it up in Stripe.' }];
}

type Row = Record<string, unknown>;
type Ctx = { task: Row; ref: Row; app: Row | null; plan: Row | null; hh: Row | null; fobs: Row[]; party: Row | null; booking: Row | null; donation: Row | null };
export type Review = {
  id: string; dispute: boolean; item: Item; family: string | null; what: string;
  amount_cents: number | null; charge_cents: number | null; partial: boolean; reason: string | null;
  created_at: string; note: string; choices: Choice[]; paid_by: boolean;
  fobs?: Array<{ id: string; tail: string | null; status: string }>;
  application_id: string | null; household_id: string | null;
};

// What a to-do is about: its metadata, or for one made before PLAN.md BT, its source.
async function refOf(sb: SupabaseClient, t: Row): Promise<Row> {
  const md = (t.metadata as Row | null) ?? {};
  if (md.item) return md;
  const id = t.source_id as string | null;
  switch (t.source_kind) {
    case 'application': return { ...md, item: 'membership', application_id: id };
    case 'payment_plan_installment': {
      const { data } = await sb.from('payment_plan_installments').select('plan_id').eq('id', String(id)).maybeSingle();
      return { ...md, item: 'membership', plan_id: data?.plan_id ?? null };
    }
    case 'keyfob': {
      const { data } = md.payment_intent
        ? await sb.from('keyfobs').select('id').eq('stripe_payment_intent_id', String(md.payment_intent)).limit(20)
        : { data: null };
      return { ...md, item: 'keyfobs', fob_ids: (data ?? []).length ? (data ?? []).map(f => f.id) : [id] };
    }
    case 'party_booking': return { ...md, item: 'party', party_id: id };
    case 'program_booking': return { ...md, item: 'program', booking_id: id };
    case 'donation': return { ...md, item: 'donation', donation_id: id };
  }
  return { ...md, item: 'unknown' };
}

async function load(sb: SupabaseClient, tid: string, task: Row): Promise<{ view: Review; ctx: Ctx }> {
  const ref = await refOf(sb, task);
  const item = (['membership', 'keyfobs', 'party', 'program', 'donation'].includes(String(ref.item)) ? ref.item : 'unknown') as Item;
  const ctx: Ctx = { task, ref, app: null, plan: null, hh: null, fobs: [], party: null, booking: null, donation: null };
  const one = async (table: string, cols: string, id: unknown) => {
    if (!id) return null;
    const { data } = await sb.from(table).select(cols).eq('id', String(id)).eq('tenant_id', tid).maybeSingle();
    return (data as Row | null) ?? null;
  };
  const state: State = {};
  let what = String(ref.what ?? '');
  let paidBy = false;

  if (item === 'membership') {
    ctx.plan = await one('payment_plans', 'id, status, household_id, application_id, family_name', ref.plan_id);
    ctx.app = await one('applications', 'id, household_id, family_name, membership_year, is_renewal, claim_source, payment_status, payment_method',
      ref.application_id ?? ctx.plan?.application_id);
    if (!ctx.plan && ctx.app?.payment_method === 'stripe_plan') {
      const { data } = await sb.from('payment_plans').select('id, status, household_id, application_id, family_name')
        .eq('tenant_id', tid).eq('application_id', String(ctx.app.id)).order('created_at', { ascending: false }).limit(1);
      ctx.plan = ((data ?? [])[0] as Row | undefined) ?? null;
    }
    ctx.hh = await one('households', 'id, family_name, active, paid_until_year, dues_paid_for_year', ref.household_id ?? ctx.app?.household_id ?? ctx.plan?.household_id);
    const planActive = ctx.plan?.status === 'active';
    state.season = (ctx.app?.membership_year as number | null) ?? (ctx.hh?.paid_until_year as number | null) ?? null;
    state.plan_active = planActive;
    state.member = !!ctx.hh && ctx.hh.active !== false && (planActive || ctx.hh.dues_paid_for_year === true);
    if (!what) what = ctx.plan && (!ctx.app || ctx.app.payment_method === 'stripe_plan')
      ? `their payment plan${state.season ? ` for ${state.season}` : ''}`
      : `their ${ctx.app?.is_renewal ? 'renewal' : 'signup'}${state.season ? ` for ${state.season}` : ''}`;
    // A signup paid in full can be marked paid another way; a plan's payments are on Upcoming.
    paidBy = !!ctx.app && ctx.app.payment_method !== 'stripe_plan' && !!state.member;
  } else if (item === 'keyfobs') {
    const ids = ((ref.fob_ids as unknown[] | undefined) ?? []).map(String).filter(Boolean);
    if (ids.length) {
      const { data } = await sb.from('keyfobs').select('id, status, card_number, household_id, level').eq('tenant_id', tid).in('id', ids);
      ctx.fobs = (data ?? []) as Row[];
    }
    state.fobs = ctx.fobs;
    ctx.hh = await one('households', 'id, family_name', ref.household_id ?? ctx.fobs[0]?.household_id);
    if (!what) what = ids.length === 1 ? 'a keyfob' : `${ids.length} keyfobs`;
  } else if (item === 'party') {
    ctx.party = await one('party_bookings', 'id, status, title, pool_date, household_id, event_id', ref.party_id);
    state.status = ctx.party?.status ?? 'cancelled';
    ctx.hh = await one('households', 'id, family_name', ref.household_id ?? ctx.party?.household_id);
    if (!what) what = `a party (${ctx.party?.title ?? 'party'}${ctx.party?.pool_date ? `, ${ctx.party.pool_date}` : ''})`;
  } else if (item === 'program') {
    ctx.booking = await one('program_bookings', 'id, status, participant_name, program_id, household_id', ref.booking_id);
    const prog = await one('programs', 'id, name', ctx.booking?.program_id);
    state.status = ctx.booking?.status ?? 'cancelled';
    state.program = prog?.name ?? null;
    ctx.hh = await one('households', 'id, family_name', ref.household_id ?? ctx.booking?.household_id);
    if (!what) what = `${prog?.name ?? 'a program'}${ctx.booking?.participant_name ? ` for ${ctx.booking.participant_name}` : ''}`;
  } else if (item === 'donation') {
    ctx.donation = await one('donations', 'id, status, amount_cents, donor_name', ref.donation_id);
    state.status = ctx.donation?.status ?? 'refunded';
    if (!what) what = 'a donation';
  } else if (!what) {
    what = 'a card payment Poolside couldn\'t match';
  }

  // Amounts: from the metadata, or the summary of a to-do made before BT.
  const summary = String(task.summary ?? '');
  const fromSummary = /\$([\d,]+\.\d{2})/.exec(summary);
  const amount = ref.amount_cents != null ? Number(ref.amount_cents) : fromSummary ? Math.round(Number(fromSummary[1].replace(/,/g, '')) * 100) : null;
  const charge = ref.charge_cents != null ? Number(ref.charge_cents) : null;
  const partial = ref.full === false || /\(partial\)/.test(summary) || (charge != null && amount != null && amount < charge);
  const dispute = /dispute/.test(String(task.kind));
  const reason = (ref.reason as string | null) ?? (dispute ? (/\(([a-z_ ]+)\)/.exec(summary)?.[1] ?? null) : null);
  const family = (ctx.hh?.family_name ?? ctx.app?.family_name ?? ctx.plan?.family_name ?? ctx.donation?.donor_name ?? ref.family ?? null) as string | null;
  const until = item === 'membership' ? (state.member ? ' They\'re still members until you pick.' : '')
    : item === 'unknown' ? ' Poolside couldn\'t tell what it paid for.' : ' Nothing changes until you pick.';
  const how = partial && amount != null && charge != null ? ` (${money(amount)} of ${money(charge)})` : '';
  const note = dispute
    ? `The card's bank is disputing this payment${reason ? ` (${String(reason).replace(/_/g, ' ')})` : ''}. Stripe decides it: answer it in Stripe, and if the club wins the money comes back.${until}`
    : `Refunded in Stripe${how}.${until}`;

  const view: Review = {
    id: String(task.id), dispute, item, family, what,
    amount_cents: amount, charge_cents: charge, partial, reason,
    created_at: String(task.created_at ?? ''), note, choices: choicesFor({ item, state }), paid_by: paidBy && !partial,
    ...(item === 'keyfobs' ? { fobs: ctx.fobs.map(f => ({ id: String(f.id), tail: tail(f.card_number), status: String(f.status) })) } : {}),
    application_id: (ctx.app?.id as string | undefined) ?? null,
    household_id: (ctx.hh?.id as string | undefined) ?? null,
  };
  return { view, ctx };
}

/** The open refunds and chargebacks, oldest first; or just one signup's. */
export async function listReviews(sb: SupabaseClient, tid: string, opts: { application_id?: string } = {}): Promise<Review[]> {
  const { data } = await sb.from('admin_tasks').select('*').eq('tenant_id', tid).in('kind', REVIEW_KINDS)
    .is('completed_at', null).is('dismissed_at', null).order('created_at').limit(100);
  const out: Review[] = [];
  for (const t of (data ?? []) as Row[]) {
    const { view } = await load(sb, tid, t);
    if (opts.application_id && view.application_id !== opts.application_id) continue;
    out.push(view);
  }
  return out;
}

async function pop(tid: string, hid: unknown, title: string, body: string, url: string) {
  if (!hid) return;
  try {
    const { pushMembers } = await import('./member_notify.ts');
    await pushMembers({ tenant_id: tid, household_ids: [String(hid)], title, body, url, tag: 'refund' });
  } catch { /* the choice is made either way */ }
}

async function turnOffTask(sb: SupabaseClient, tid: string, fob: Row, family: string | null, why: string) {
  const { enqueueAdminTask } = await import('./enqueue_task.ts');
  await enqueueAdminTask(sb, {
    tenant_id: tid, target_scopes: ['keyfobs'], kind: 'keyfob.off',
    summary: `Turn off the ${family ?? 'family'}'s keyfob ${tail(fob.card_number) ?? ''}: ${why}`.replace(' :', ':'),
    link_url: '/club/admin/keyfobs.html', source_kind: 'keyfob', source_id: String(fob.id),
    push_title: '🔑 Keyfob to turn off', push_body: `${family ?? 'A family'}: ${why}.`,
  });
}

/** Do a choice, close the to-do with it, and write it in the audit log. */
export async function decideReview(
  sb: SupabaseClient, tid: string, taskId: string,
  input: { choice: string; paid_by?: string | null; fob_ids?: string[] | null; by: string | null },
): Promise<{ ok: boolean; done?: string; error?: string }> {
  const { data: task } = await sb.from('admin_tasks').select('*').eq('id', taskId).eq('tenant_id', tid).maybeSingle();
  if (!task || !REVIEW_KINDS.includes(String(task.kind))) return { ok: false, error: 'That refund isn\'t here.' };
  if (task.completed_at || task.dismissed_at) return { ok: false, error: 'Someone already decided this one.' };
  const { view, ctx } = await load(sb, tid, task as Row);
  const choice = String(input.choice ?? '');
  if (!view.choices.some(c => c.key === choice)) return { ok: false, error: 'That choice isn\'t open for this one.' };
  const now = new Date().toISOString();
  const fam = view.family ?? 'The family';
  const word = view.dispute ? 'disputed' : 'refunded';
  let done = 'Done.';
  const paidBy = input.paid_by && PAID_BY[input.paid_by] && view.paid_by ? input.paid_by : null;

  if (choice === 'end') {
    const season = (ctx.app?.membership_year as number | null) ?? null;
    if (ctx.hh) {
      const patch: Row = { dues_paid_for_year: false };
      // Back to the season before, only for a family that was a member then:
      // a new family counted as last season's would get a renewal invite.
      if (season != null && Number(ctx.hh.paid_until_year) === season) {
        patch.paid_until_year = ctx.app?.is_renewal || ctx.app?.claim_source === 'csv_import' ? season - 1 : null;
      }
      await sb.from('households').update(patch).eq('id', String(ctx.hh.id)).eq('tenant_id', tid);
      const { data: fobs } = await sb.from('keyfobs').select('id, card_number, status, level')
        .eq('tenant_id', tid).eq('household_id', String(ctx.hh.id)).eq('status', 'active');
      // Board and staff fobs aren't the membership's.
      for (const f of ((fobs ?? []) as Row[]).filter(f => f.level == null || f.level === 'member')) {
        await turnOffTask(sb, tid, f, view.family, 'their membership ended after a refund');
      }
    }
    if (ctx.plan?.status === 'active') {
      await sb.from('payment_plans').update({ status: 'cancelled', cancelled_at: now, ended_reason: 'refunded' }).eq('id', String(ctx.plan.id));
    }
    await pop(tid, ctx.hh?.id, 'Your membership has ended',
      `Your ${season ? season + ' ' : ''}membership has ended${view.dispute ? '' : ' and your payment was refunded'}. Ask the board if you have questions.`, '/m/');
    done = `${fam}'s membership ended.`;
  } else if (choice === 'keep' && view.item === 'membership') {
    if (paidBy && ctx.app) {
      await sb.from('applications').update({
        payment_method: paidBy, payment_status: 'paid', paid_at: now, verified_at: now, verified_by: input.by,
        payment_reference: `Paid by ${PAID_BY[paidBy]} after the card payment was ${word}`,
      }).eq('id', String(ctx.app.id)).eq('tenant_id', tid);
    }
    done = paidBy ? `Kept as members, paid by ${PAID_BY[paidBy]}.` : 'Kept as members.';
  } else if (choice === 'fobs_off') {
    const ticked = (input.fob_ids ?? []).map(String);
    const pick = ctx.fobs.filter(f => !ticked.length || ticked.includes(String(f.id)));
    let off = 0, canceled = 0;
    for (const f of pick) {
      if (f.status === 'active') { await turnOffTask(sb, tid, f, view.family, `its payment was ${word}`); off++; }
      else if (f.status === 'requested') {
        await sb.from('keyfobs').delete().eq('id', String(f.id)).eq('tenant_id', tid);
        await sb.from('admin_tasks').update({ completed_at: now, completed_by: input.by })
          .eq('source_kind', 'keyfob').eq('source_id', String(f.id)).is('completed_at', null);
        canceled++;
      }
    }
    if (canceled) {
      await pop(tid, ctx.hh?.id, '🔑 Keyfob request canceled',
        `Your keyfob payment was ${word}, so ${canceled === 1 ? 'the request is' : 'the requests are'} canceled. Ask the board if you still need one.`, '/m/#keyfobs');
    }
    done = [off ? `${off} fob${off === 1 ? '' : 's'} to turn off (a to-do for the keyfob person)` : '', canceled ? `${canceled} request${canceled === 1 ? '' : 's'} canceled` : '']
      .filter(Boolean).join(', ') + '.';
    if (done === '.') done = 'Nothing to turn off.';
    done = done.charAt(0).toUpperCase() + done.slice(1);
  } else if (choice === 'cancel_party' && ctx.party) {
    const { cancelParty } = await import('./party_cancel.ts');
    await cancelParty(sb, tid, String(ctx.party.id), input.by);
    await pop(tid, ctx.party.household_id, '🎉 Your party is canceled',
      `Your party${ctx.party.pool_date ? ` on ${ctx.party.pool_date}` : ''} is canceled and its payment was ${word}. Ask the board if you have questions.`, '/m/#parties');
    done = 'The party is canceled.';
  } else if (choice === 'cancel_booking' && ctx.booking) {
    await sb.from('program_bookings').update({ status: 'cancelled', updated_at: now }).eq('id', String(ctx.booking.id)).eq('tenant_id', tid);
    done = `${ctx.booking.participant_name ?? 'They'} ${ctx.booking.participant_name ? 'is' : 'are'} off the program.`;
  } else if (choice === 'off_total' && ctx.donation) {
    // All of it: refunded. Part: the donation counts for what's left.
    const left = Number(ctx.donation.amount_cents ?? 0) - Number(view.amount_cents ?? 0);
    await sb.from('donations').update(view.partial && left > 0 ? { amount_cents: left } : { status: 'refunded' })
      .eq('id', String(ctx.donation.id)).eq('tenant_id', tid);
    const { recomputeFundraiser } = await import('./fundraiser.ts');
    await recomputeFundraiser(sb, tid);
    done = 'Taken off the fundraiser.';
  } else if (choice === 'keep') {
    done = 'Nothing changed.';
  }

  await sb.from('admin_tasks').update({
    completed_at: now, completed_by: input.by,
    metadata: { ...((task.metadata as Row | null) ?? {}), decision: choice, ...(paidBy ? { paid_by: paidBy } : {}) },
  }).eq('id', taskId);
  await sb.from('audit_log').insert({
    tenant_id: tid, kind: 'refund.decided', entity_type: 'admin_task', entity_id: taskId,
    summary: `${view.dispute ? 'Chargeback' : 'Refund'} on ${view.what}${view.family ? ` (${view.family})` : ''}: ${done}`,
    actor_id: input.by, actor_kind: 'tenant_admin',
  });
  return { ok: true, done };
}

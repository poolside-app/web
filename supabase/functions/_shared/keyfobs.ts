// =============================================================================
// keyfobs.ts — the family's keyfobs (PLAN.md P, Doug 2026-10-08)
// =============================================================================
// One row per fob (table keyfobs). A new family gets the club's included fobs
// (1 at Bishop), counted once per family ever; extras and replacements cost
// the club's fee ($15 at Bishop) and are paid before the board issues them.
// Poolside, not a checkbox, decides who is new: a renewal never gets a free
// fob, the signup form turns away existing and imported members, and a
// signup at the address of a past member is flagged for the board.
//
// Pure helpers first (scripts/test_keyfobs.mjs), then the few that touch
// the database.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type FobSettings = { enabled: boolean; included_free: number; fee_cents: number; max_per_family: number };

export function fobSettings(sv: unknown): FobSettings {
  const v = (sv ?? {}) as Record<string, unknown>;
  const k = (v.keyfobs as Record<string, unknown> | undefined) ?? {};
  const inc = Number(k.included_free ?? 1);
  const fee = Number(k.fee_cents ?? 1500);
  const max = Number(k.max_per_family ?? 5);
  return {
    enabled: !!(v.features as Record<string, unknown> | undefined)?.keyfobs,
    included_free: Number.isFinite(inc) && inc >= 0 ? Math.min(6, Math.trunc(inc)) : 1,
    fee_cents: Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : 1500,
    // Working fobs a family can hold, the free one included (Doug, 10/8).
    max_per_family: Number.isFinite(max) && max >= 1 ? Math.min(20, Math.trunc(max)) : 5,
  };
}

/**
 * Extra fobs added at checkout (PLAN.md Q): as many as they asked for, up
 * to the family limit counting the fobs they have and the free one coming.
 */
export function fobExtras(s: FobSettings, opts: { requested: unknown; have: number; free: number }): { count: number; cents: number; room: number } {
  const room = Math.max(0, s.max_per_family - Math.max(0, opts.have) - Math.max(0, opts.free));
  const want = Math.trunc(Number(opts.requested));
  const count = Number.isFinite(want) && want > 0 ? Math.min(want, room) : 0;
  return { count, cents: count * s.fee_cents, room };
}

/** Fob numbers on a line from the club's list: "786777; 012,00345". */
export function listFobNumbers(raw: unknown): number[] {
  const out: number[] = [];
  for (const part of String(raw ?? '').split(/[;\n]|,(?=\s*\d{4,})/)) {
    const p = parseFobNumber(part);
    if (p.ok && !out.includes(p.number)) out.push(p.number);
  }
  return out;
}

/**
 * A fob's number as the board reads it off the fob. Blank fobs print it two
 * ways: a decimal like 0000786777, and a facility,card pair like 012,00345.
 * The panel's number is facility × 65536 + card, so both are the same key
 * (12 × 65536 + 345 = 786777).
 */
export function parseFobNumber(raw: unknown): { ok: true; number: number } | { ok: false; error: string } {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, error: 'Type the number printed on the fob.' };
  const pair = s.match(/^(\d{1,3})\s*[,.\s/-]\s*(\d{1,5})$/);
  if (pair) {
    const facility = Number(pair[1]), card = Number(pair[2]);
    if (facility > 255) return { ok: false, error: 'The first part (before the comma) is 0 to 255.' };
    if (card > 65535) return { ok: false, error: 'The second part (after the comma) is 0 to 65535.' };
    return { ok: true, number: facility * 65536 + card };
  }
  if (/^\d{1,10}$/.test(s)) {
    const n = Number(s);
    if (n <= 0 || n > 4294967295) return { ok: false, error: 'That number is too long to be a fob number.' };
    return { ok: true, number: n };
  }
  return { ok: false, error: 'Use the number on the fob: all digits (like 0000786777) or two parts with a comma (like 012,00345).' };
}

/** The last 4 digits, the way the board and the family see a fob. */
export function fobTail(n: number | null | undefined): string {
  return n == null ? '' : '•••' + String(n).slice(-4);
}

/** A street line made comparable: "4549 Lincoln Dr." and "4549 lincoln drive". */
export function normalizeAddress(raw: unknown): string {
  const words: Record<string, string> = {
    street: 'st', avenue: 'ave', drive: 'dr', court: 'ct', lane: 'ln', road: 'rd', circle: 'cir',
    place: 'pl', boulevard: 'blvd', terrace: 'ter', parkway: 'pkwy', highway: 'hwy', north: 'n', south: 's', east: 'e', west: 'w',
  };
  return String(raw ?? '').toLowerCase().replace(/[.,#]/g, ' ').split(/\s+/).filter(Boolean)
    .map(w => words[w] ?? w).join(' ').trim();
}

/** What a card payment for a fob comes to: the card fee is the member's. */
/**
 * May this request be canceled? Only before it's paid (Doug, 10/9, PLAN.md
 * X2): waiting to be paid, or free. Paid by card, with the dues, or a Venmo
 * the family says they sent: no cancel, on either side.
 */
export function canCancel(f: { status?: unknown; payment_status?: unknown }): boolean {
  return f.status === 'requested' && (f.payment_status === 'unpaid' || f.payment_status === 'none');
}

export function fobCardTotal(feeCents: number, pct = 0.029, fixed = 30): number {
  return feeCents > 0 ? Math.ceil((feeCents + fixed) / (1 - pct)) : 0;
}

// ── database ────────────────────────────────────────────────────────────────

/** Keep households.fob_number (the Members list's "Fob" column) in step with
 *  the family's active fobs. */
export async function syncHouseholdFobs(sb: SupabaseClient, householdId: string): Promise<void> {
  const { data } = await sb.from('keyfobs').select('card_number').eq('household_id', householdId)
    .eq('status', 'active').not('card_number', 'is', null).order('issued_at');
  const nums = (data ?? []).map(r => String(r.card_number));
  await sb.from('households').update({ fob_number: nums.length ? nums.join(', ') : null }).eq('id', householdId);
}

/** Fobs that count toward the family limit: working or on their way. */
export async function liveFobCount(sb: SupabaseClient, householdId: string): Promise<number> {
  const { count } = await sb.from('keyfobs').select('id', { count: 'exact', head: true })
    .eq('household_id', householdId).in('status', ['requested', 'active']);
  return count ?? 0;
}

/** How many included (free) fobs this family has already had, ever. */
export async function includedUsed(sb: SupabaseClient, householdId: string): Promise<number> {
  const { count } = await sb.from('keyfobs').select('id', { count: 'exact', head: true })
    .eq('household_id', householdId).eq('included', true);
  return count ?? 0;
}

/**
 * A family's own past: the past members a new signup's street address matches
 * (a household in Poolside, or a family imported from the club's list). Not
 * a block, since houses change hands; it puts a note in front of the board
 * before a free fob goes out.
 */
export async function addressMatch(sb: SupabaseClient, tenantId: string, address: string | null): Promise<string | null> {
  const want = normalizeAddress(address);
  if (want.length < 5 || !/^\d/.test(want)) return null;
  const num = want.split(' ')[0];
  const [{ data: hh }, { data: apps }] = await Promise.all([
    sb.from('households').select('family_name, address, paid_until_year').eq('tenant_id', tenantId).ilike('address', `${num}%`).limit(50),
    sb.from('applications').select('family_name, address, status').eq('tenant_id', tenantId).ilike('address', `${num}%`)
      .in('status', ['prefilled', 'approved']).limit(50),
  ]);
  const h = (hh ?? []).find(r => normalizeAddress(r.address) === want);
  if (h) return `Same address as the ${h.family_name}${h.paid_until_year ? ` (member through ${h.paid_until_year})` : ''}. New owners, or the same family?`;
  const a = (apps ?? []).find(r => normalizeAddress(r.address) === want);
  if (a) return `Same address as the ${a.family_name} on the club's member list. New owners, or the same family?`;
  return null;
}

/**
 * A membership was approved (PLAN.md Q4): set up its fobs and ask the board
 * once. A family from the club's list brings its fob numbers; a new family
 * that wants it gets the free fob (with a note if they share a past
 * member's address); extras bought at checkout were paid with the dues. A
 * renewal (isNew false) never gets the free one.
 */
export async function fobsAtApproval(sb: SupabaseClient, args: {
  tenantId: string; householdId: string; isNew: boolean;
  app: { family_name?: unknown; need_new_fob?: unknown; prior_fob_number?: unknown; fob_review_note?: unknown; fob_extra_count?: unknown };
}): Promise<{ imported: number; free: number; extra: number }> {
  const { data: sv } = await sb.from('settings').select('value').eq('tenant_id', args.tenantId).maybeSingle();
  const s = fobSettings(sv?.value);
  const out = { imported: 0, free: 0, extra: 0 };
  if (!s.enabled) return out;
  const now = new Date().toISOString();
  const hid = args.householdId, TID = args.tenantId;
  for (const n of listFobNumbers(args.app.prior_fob_number)) {
    const { error } = await sb.from('keyfobs').insert({ tenant_id: TID, household_id: hid, card_number: n, status: 'active', reason: 'imported', issued_at: now });
    if (!error) out.imported++;
  }
  const note = (args.app.fob_review_note as string | null) ?? null;
  if (args.isNew && args.app.need_new_fob === true && s.included_free > 0 && (await includedUsed(sb, hid)) < s.included_free) {
    await sb.from('keyfobs').insert({ tenant_id: TID, household_id: hid, status: 'requested', reason: 'new_member',
      included: true, payment_status: 'none', check_note: note });
    out.free = 1;
  }
  // Paid with the dues: the limit was checked when they were priced.
  const extra = Math.max(0, Math.min(20, Math.trunc(Number(args.app.fob_extra_count) || 0)));
  const fee = s.fee_cents;
  for (let i = 0; i < extra; i++) {
    await sb.from('keyfobs').insert({ tenant_id: TID, household_id: hid, status: 'requested', reason: 'extra',
      included: false, price_cents: fee, payment_status: 'paid', payment_method: 'with_dues', paid_at: now });
  }
  out.extra = extra;
  await syncHouseholdFobs(sb, hid);
  const total = out.free + out.extra;
  if (total > 0) {
    const fam = String(args.app.family_name ?? 'family');
    const parts = [out.free ? '1 free' : '', out.extra ? `${out.extra} paid with their membership` : ''].filter(Boolean).join(', ');
    const { enqueueAdminTask } = await import('./enqueue_task.ts');
    await enqueueAdminTask(sb, {
      tenant_id: TID, target_scopes: ['keyfobs'], kind: 'keyfob.issue',
      summary: `Issue ${total === 1 ? 'a keyfob' : total + ' keyfobs'} to the ${fam} (${parts})${out.free && note ? ' · check: ' + note : ''}`,
      link_url: '/club/admin/keyfobs.html', source_kind: 'keyfob_household', source_id: hid,
      push_title: '🔑 Keyfobs to issue', push_body: `The ${fam} need ${total === 1 ? 'a keyfob' : total + ' keyfobs'}.`,
    });
  }
  return out;
}

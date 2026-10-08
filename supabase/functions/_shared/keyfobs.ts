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

export type FobSettings = { enabled: boolean; included_free: number; fee_cents: number };

export function fobSettings(sv: unknown): FobSettings {
  const v = (sv ?? {}) as Record<string, unknown>;
  const k = (v.keyfobs as Record<string, unknown> | undefined) ?? {};
  const inc = Number(k.included_free ?? 1);
  const fee = Number(k.fee_cents ?? 1500);
  return {
    enabled: !!(v.features as Record<string, unknown> | undefined)?.keyfobs,
    included_free: Number.isFinite(inc) && inc >= 0 ? Math.min(6, Math.trunc(inc)) : 1,
    fee_cents: Number.isFinite(fee) && fee >= 0 ? Math.round(fee) : 1500,
  };
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

// =============================================================================
// party_slots.ts — when a party can be booked (PLAN.md O, Doug 2026-10-07)
// =============================================================================
// A family picks a date and start time; the party runs the club's set length.
// Two parties can share a day but never overlap. A time that's open is
// approved on the spot (a setting, on by default), and paying by card books
// it instantly. An approved party that isn't paid holds its time for the
// club's hold (2 days); a Venmo the family says they sent holds it until the
// board confirms the money arrived.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { partyHours } from './party_length.ts';

export type PartySettings = { hours: number; fee_cents: number; auto_approve: boolean; hold_days: number };

export function partySettings(sv: unknown): PartySettings {
  const v = (sv ?? {}) as Record<string, unknown>;
  const p = (v.parties as Record<string, unknown> | undefined) ?? {};
  const fee = Number(p.fee_cents ?? v.party_price_cents ?? 0);
  const hold = Number(p.hold_days ?? 2);
  return {
    hours: partyHours(v),
    fee_cents: Number.isFinite(fee) && fee > 0 ? Math.round(fee) : 0,
    auto_approve: p.auto_approve !== false,
    hold_days: Number.isFinite(hold) && hold > 0 ? Math.min(30, hold) : 2,
  };
}

/** What a card payment for a party comes to: the card fee always goes on the
 *  member, never the club (Doug, 2026-10-07). */
export function partyCardTotal(feeCents: number, pct = 0.029, fixed = 30): number {
  return feeCents > 0 ? Math.ceil((feeCents + fixed) / (1 - pct)) : 0;
}

type Row = { id: string; title?: string; starts_at: string; ends_at: string | null; status: string; payment_status: string | null; decided_at: string | null };

/** Whether a party still holds its time: booked, a Venmo waiting on the
 *  board, approved and inside the hold, or a request waiting on the board. */
export function holdsTime(r: Row, holdDays: number, now = Date.now()): boolean {
  if (r.status === 'pending') return true;
  if (r.status !== 'approved') return false;
  if (r.payment_status === 'paid' || r.payment_status === 'pending_verify') return true;
  const since = r.decided_at ? Date.parse(r.decided_at) : now;
  return now - since < holdDays * 86400_000;
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(bStart) < Date.parse(aEnd);
}

/** Parties that hold time overlapping [start, end). */
export async function clashes(
  sb: SupabaseClient, tenantId: string, start: string, end: string, s: PartySettings, exceptId?: string,
): Promise<Row[]> {
  const from = new Date(Date.parse(start) - 24 * 3600_000).toISOString();
  const { data } = await sb.from('party_bookings')
    .select('id, title, starts_at, ends_at, status, payment_status, decided_at')
    .eq('tenant_id', tenantId).in('status', ['pending', 'approved'])
    .gte('starts_at', from).lt('starts_at', end).limit(50);
  return ((data ?? []) as Row[]).filter(r => r.id !== exceptId && holdsTime(r, s.hold_days) &&
    overlaps(start, end, r.starts_at, r.ends_at ?? new Date(Date.parse(r.starts_at) + s.hours * 3600_000).toISOString()));
}

/** The times already taken on a pool day ('YYYY-MM-DD'), for the request form. */
export async function busyTimes(sb: SupabaseClient, tenantId: string, poolDay: string, s: PartySettings): Promise<Array<{ starts_at: string; ends_at: string }>> {
  const { data } = await sb.from('party_bookings')
    .select('id, starts_at, ends_at, status, payment_status, decided_at')
    .eq('tenant_id', tenantId).eq('pool_date', poolDay).in('status', ['pending', 'approved']).limit(20);
  return ((data ?? []) as Row[]).filter(r => holdsTime(r, s.hold_days))
    .map(r => ({ starts_at: r.starts_at, ends_at: r.ends_at ?? new Date(Date.parse(r.starts_at) + s.hours * 3600_000).toISOString() }))
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

/** Booked parties (paid, or a Venmo waiting on the board) that overlap this
 *  one: the check before a payment books it, and before the board approves. */
export async function bookedClashes(
  sb: SupabaseClient, tenantId: string,
  party: { id: string; starts_at: string; ends_at: string | null }, s: PartySettings,
): Promise<Row[]> {
  const end = party.ends_at ?? new Date(Date.parse(party.starts_at) + s.hours * 3600_000).toISOString();
  const all = await clashes(sb, tenantId, party.starts_at, end, s, party.id);
  return all.filter(r => r.status === 'approved' && (r.payment_status === 'paid' || r.payment_status === 'pending_verify'));
}

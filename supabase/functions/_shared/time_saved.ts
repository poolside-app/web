// =============================================================================
// time_saved.ts — Insights → Time saved (PLAN.md BB, Doug 10/19)
// =============================================================================
// Doug: "i want to show how much time is saved by using this app". Built on
// Bishop's real old process, not guesses about posts and photos: the Jotform
// set up each season, the treasurer keying each signup into Excel and
// cross-checking Venmo and PayPal, Doug remoting in to turn fobs on in
// batches. Only things that actually happened in Poolside are counted, each
// with the minutes it used to take; the board can change any of them
// (settings.time_saved). Dollars are "if the club paid someone" at $20 an
// hour, Doug's number.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const ITEMS: Array<{ key: string; label: string; before: string }> = [
  { key: 'signup_form', label: 'Signup form, each season', before: 'Building the signup form in Jotform for the season.' },
  { key: 'signup', label: 'Signups and renewals', before: 'Typing each family into the spreadsheet and checking it line by line.' },
  { key: 'payment', label: 'Payments confirmed', before: 'Cross-checking Venmo or PayPal and marking the family paid.' },
  { key: 'keyfob', label: 'Keyfobs turned on or off', before: 'Signing in to the gate computer and finding the family to turn a fob on or off.' },
  { key: 'plan_payment', label: 'Plan payments collected', before: 'Reminding the family and recording each payment.' },
  { key: 'party', label: 'Parties booked', before: 'Calls and emails back and forth to book a date and take the fee.' },
  { key: 'door', label: 'Doors opened remotely and passes', before: 'A trip to the pool to let someone in.' },
];

export const DEFAULT_MINUTES: Record<string, number> = {
  signup_form: 60, signup: 10, payment: 5, keyfob: 10, plan_payment: 5, party: 20, door: 15,
};
export const DEFAULT_PER_HOUR = 20;

export type TimeSavedSettings = { per_hour: number; minutes: Record<string, number> };

/** The board's numbers, kept sensible: 0–600 minutes, $0–$200 an hour. */
export function cleanTimeSaved(raw: unknown): TimeSavedSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const m = (r.minutes && typeof r.minutes === 'object' ? r.minutes : {}) as Record<string, unknown>;
  const num = (v: unknown, def: number, max: number) => {
    const n = Number(v);
    return v === undefined || v === null || v === '' || !Number.isFinite(n) ? def : Math.min(max, Math.max(0, Math.round(n)));
  };
  const minutes: Record<string, number> = {};
  for (const i of ITEMS) minutes[i.key] = num(m[i.key], DEFAULT_MINUTES[i.key], 600);
  return { per_hour: num(r.per_hour, DEFAULT_PER_HOUR, 200), minutes };
}

export function computeTimeSaved(counts: Record<string, number>, s: TimeSavedSettings) {
  const rows = ITEMS.map(i => {
    const count = Math.max(0, Math.round(Number(counts[i.key]) || 0));
    return { ...i, count, minutes_each: s.minutes[i.key], total_minutes: count * s.minutes[i.key] };
  });
  const minutes = rows.reduce((n, r) => n + r.total_minutes, 0);
  const hours = minutes / 60;
  return { rows, minutes, hours, per_hour: s.per_hour, dollars: Math.round(hours * s.per_hour) };
}

/** How many times Poolside did each thing for this club, since it started. */
export async function countTimeSaved(sb: SupabaseClient, tenantId: string): Promise<Record<string, number>> {
  const n = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;
  const head = { count: 'exact' as const, head: true };
  const [seasons, signups, appsPaid, partiesPaid, fobsPaid, fobsIssued, fobsOff, planAuto, parties, boardOpens, passes] = await Promise.all([
    sb.from('applications').select('membership_year').eq('tenant_id', tenantId).eq('status', 'approved').limit(5000),
    n(sb.from('applications').select('id', head).eq('tenant_id', tenantId).eq('status', 'approved')),
    n(sb.from('applications').select('id', head).eq('tenant_id', tenantId).eq('payment_status', 'paid')),
    n(sb.from('party_bookings').select('id', head).eq('tenant_id', tenantId).eq('payment_status', 'paid')),
    n(sb.from('keyfobs').select('id', head).eq('tenant_id', tenantId).eq('payment_status', 'paid').gt('price_cents', 0)),
    // Fobs brought over from the old program were never issued here.
    n(sb.from('keyfobs').select('id', head).eq('tenant_id', tenantId).not('issued_at', 'is', null).neq('reason', 'imported')),
    n(sb.from('keyfobs').select('id', head).eq('tenant_id', tenantId).not('turned_off_at', 'is', null)),
    // Charged on their own, not the first payment at checkout.
    n(sb.from('payment_plan_installments').select('id', head).eq('tenant_id', tenantId).eq('status', 'paid').is('stripe_session_id', null)),
    n(sb.from('party_bookings').select('id', head).eq('tenant_id', tenantId).eq('status', 'approved')),
    n(sb.from('gate_unlocks').select('id', head).eq('tenant_id', tenantId).eq('status', 'done').not('admin_user_id', 'is', null).eq('is_test', false)),
    n(sb.from('access_passes').select('id', head).eq('tenant_id', tenantId).or('source_kind.is.null,source_kind.neq.party')),
  ]);
  const years = new Set(((seasons as { data: Array<{ membership_year: number | null }> | null }).data ?? []).map(r => r.membership_year).filter(Boolean));
  return {
    signup_form: years.size,
    signup: signups,
    payment: appsPaid + partiesPaid + fobsPaid,
    keyfob: fobsIssued + fobsOff,
    plan_payment: planAuto,
    party: parties,
    door: boardOpens + passes,
  };
}

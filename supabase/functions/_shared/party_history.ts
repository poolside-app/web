// =============================================================================
// party_history.ts — what happened to each party, for the Parties tab (PLAN.md BP)
// =============================================================================
// Doug, 2026-11-03: the Drive backup should show the history of every party,
// "even if they are scheduled and cancelled to track what actually happened".
// A database trigger writes a party_history row each time a party's status,
// payment, time or price changes (migration 20261103000100). This turns those
// rows, plus Stripe refunds and chargebacks from the audit log, into steps
// ("Nov 4: approved") and one row for the sheet.
// =============================================================================

import type { ColSpec } from './sheet_look.ts';
import { fmtPoolDate, fmtPoolTime, wallParts } from './pool_time.ts';
import { sheetSafe } from './drive_row.ts';

export type PartyStep = {
  booking_id: string;
  at: string;
  op: 'insert' | 'update' | 'snapshot';
  status: string | null;
  payment_status: string | null;
  payment_method: string | null;
  starts_at: string | null;
  ends_at: string | null;
  price_cents: number | null;
  expected_guests: number | null;
  title: string | null;
  family_name: string | null;
  note: string | null;
  decided_at: string | null;
  created_at: string | null;
};
/** An audit_log row about a party's payment (kind payment.refund or payment.dispute). */
export type PartyMoney = { entity_id: string; kind: string; created_at: string; summary: string | null };

export const PARTY_COLUMNS: ColSpec[] = [
  { label: 'Party Date',    width: 140, align: 'LEFT', formula: true,
    numberFormat: { type: 'DATE_TIME', pattern: 'ddd, mmm d, yyyy' } },
  { label: 'Time',          width: 130, align: 'LEFT' },
  { label: 'Family',        width: 170, align: 'LEFT' },
  { label: 'Party',         width: 170, align: 'LEFT' },
  { label: 'Guests',        width:  70, align: 'CENTER',
    numberFormat: { type: 'NUMBER', pattern: '0' } },
  { label: 'Status',        width: 190, align: 'LEFT', chips: [
    { startsWith: 'Booked, paid', color: 'green' }, { startsWith: 'Booked', color: 'gray' },
    { startsWith: 'Approved', color: 'amber' }, { startsWith: 'Requested', color: 'blue' },
    { startsWith: 'Canceled', color: 'red' }, { startsWith: 'Turned down', color: 'red' },
  ] },
  { label: 'Amount',        width:  90, align: 'RIGHT' },
  { label: 'Paid By',       width:  90, align: 'CENTER' },
  { label: 'What happened', width: 360, align: 'LEFT', wrap: true },   // one step per line
  { label: 'Requested',     width: 150, align: 'LEFT', formula: true,
    numberFormat: { type: 'DATE_TIME', pattern: 'mmm d, yyyy h:mm am/pm' } },
  { label: 'Party ID',      width: 100, align: 'LEFT' },
];

const money = (c: number | null) => (c == null ? '' : `$${(c / 100).toFixed(2)}`);
const how = (m: string | null) => (m === 'stripe' ? 'card' : m === 'venmo' ? 'Venmo' : m || 'another way');
const day = (at: string, tz: string) => fmtPoolDate(at, tz, { month: 'short', day: 'numeric' });
const note = (s: string | null) => (s && s.trim() ? ` (${s.trim().replace(/\.$/, '')})` : '');

/** "2:00–5:00 PM", or "11:00 AM–2:00 PM" across noon. */
export function partyTime(starts: string | null, ends: string | null, tz: string): string {
  if (!starts) return '';
  const a = fmtPoolTime(starts, tz);
  if (!ends) return a;
  const b = fmtPoolTime(ends, tz);
  const [at, am] = a.split(' '), [bt, bm] = b.split(' ');
  return am && am === bm ? `${at}–${bt} ${bm}` : `${a}–${b}`;
}
function when(e: PartyStep, tz: string): string {
  if (!e.starts_at) return 'a new time';
  const d = fmtPoolDate(e.starts_at, tz, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return `${d}, ${partyTime(e.starts_at, e.ends_at, tz)}`;
}
function paidWords(e: PartyStep): string | null {
  if (e.payment_status === 'paid') return `paid by ${how(e.payment_method)} ${money(e.price_cents)}`;
  if (e.payment_status === 'pending_verify') return 'Venmo sent, waiting for the board to check it';
  return null;
}
function canceledWords(e: PartyStep, before: PartyStep | null): string {
  const n = String(e.note ?? '').trim();
  if (/^Released/i.test(n)) return `released: ${n.replace(/^Released:?\s*/i, '').replace(/^./, c => c.toLowerCase()).replace(/\.$/, '')}`;
  if (/^Auto-cancel/i.test(n)) return 'canceled automatically: another party had booked that time first, so a refund is due';
  if (e.decided_at && e.decided_at !== before?.decided_at) return `canceled by the board${note(n)}`;
  return 'canceled by the family';
}
function statusWords(e: PartyStep, before: PartyStep | null): string | null {
  switch (e.status) {
    case 'pending': return before ? 'back to requested' : null;
    case 'approved': return 'approved';
    case 'rejected': return `turned down${note(e.note)}`;
    case 'cancelled': return canceledWords(e, before);
    default: return e.status;
  }
}

/** Each step of one party, oldest first: "Nov 4: approved". */
export function partySteps(entries: PartyStep[], refunds: PartyMoney[], tz: string): string[] {
  const out: Array<{ at: string; text: string }> = [];
  entries.forEach((e, i) => {
    const before = i ? entries[i - 1] : null;
    const add = (text: string | null) => { if (text) out.push({ at: e.at, text }); };
    if (!before) {
      if (e.op === 'snapshot') {
        // A party from before the history began: when it was asked for, then where it stood.
        out.push({ at: e.created_at || e.at, text: 'requested' });
        const stood = e.status === 'cancelled' ? [paidWords(e), canceledWords(e, null)]
          : [e.status === 'pending' ? null : statusWords(e, null), paidWords(e)];
        const now = stood.filter(Boolean) as string[];
        if (now.length) add(now.join(' and '));
      } else {
        add(e.status === 'pending' ? 'requested' : `requested and ${statusWords(e, null)}`);
        if (e.payment_status === 'paid' || e.payment_status === 'pending_verify') add(paidWords(e));
      }
      return;
    }
    if (e.payment_status !== before.payment_status) {
      add(paidWords(e) ?? (e.payment_status === 'unpaid' ? 'marked not paid' : `payment: ${e.payment_status}`));
    }
    if (e.starts_at !== before.starts_at || e.ends_at !== before.ends_at) add(`moved to ${when(e, tz)}`);
    if (e.price_cents !== before.price_cents) add(`price changed to ${money(e.price_cents)}`);
    if (e.status !== before.status) add(statusWords(e, before));
  });
  for (const r of refunds) {
    const amt = (String(r.summary ?? '').match(/\$[\d,]+\.\d\d/) || [''])[0];
    const partial = /partial/i.test(String(r.summary ?? '')) ? ' (part of it)' : '';
    out.push({ at: r.created_at, text: r.kind === 'payment.dispute' ? `chargeback ${amt} opened in Stripe` : `refunded ${amt} in Stripe${partial}` });
  }
  return out.map((s, i) => ({ ...s, i }))
    .sort((a, b) => (Date.parse(a.at) - Date.parse(b.at)) || (a.i - b.i))
    .map(s => `${day(s.at, tz)}: ${s.text}`);
}

/** Where the party stands now. */
export function partyStatus(latest: PartyStep, refunds: PartyMoney[]): string {
  const refunded = refunds.some(r => r.kind === 'payment.refund');
  const disputed = refunds.some(r => r.kind === 'payment.dispute') ? '; chargeback' : '';
  const paid = latest.payment_status === 'paid';
  switch (latest.status) {
    case 'pending': return 'Requested' + disputed;
    case 'rejected': return 'Turned down' + disputed;
    case 'approved':
      return (refunded ? 'Booked, refunded' : paid ? 'Booked, paid'
        : latest.payment_status === 'pending_verify' ? 'Approved, Venmo to check' : 'Approved, not paid yet') + disputed;
    case 'cancelled':
      return (refunded ? 'Canceled, refunded' : paid ? 'Canceled after it was paid' : 'Canceled') + disputed;
    default: return String(latest.status ?? '') + disputed;
  }
}

/** One party's row for the Parties tab, by column name. */
export function partyRecord(entries: PartyStep[], refunds: PartyMoney[], tz: string): Record<string, unknown> {
  const last = entries[entries.length - 1];
  const first = entries[0];
  const d = last.starts_at ? wallParts(last.starts_at, tz) : null;
  const asked = first.created_at || first.at;
  const r = wallParts(asked, tz);
  return {
    'Party Date':    d ? `=DATE(${d.year},${d.month},${d.day})` : '',
    'Time':          partyTime(last.starts_at, last.ends_at, tz),
    'Family':        sheetSafe(String(last.family_name ?? '')),
    'Party':         sheetSafe(String(last.title ?? '')),
    'Guests':        last.expected_guests ?? '',
    'Amount':        money(last.price_cents),
    'Paid By':       last.payment_status === 'paid' || last.payment_status === 'pending_verify'
                       ? (last.payment_method === 'stripe' ? 'Card' : last.payment_method === 'venmo' ? 'Venmo' : String(last.payment_method ?? '')) : '',
    'Status':        partyStatus(last, refunds),
    'What happened': partySteps(entries, refunds, tz).join('\n'),           // one step per line (PLAN.md BR1)
    'Requested':     `=DATE(${r.year},${r.month},${r.day})+TIME(${r.hour},${r.minute},${r.second})`,
    'Party ID':      last.booking_id,
  };
}

// =============================================================================
// drive_row.ts — what a signup's row in the Drive roster says (PLAN.md BO)
// =============================================================================
// Doug, 2026-11-03: the backup should have everyone's names, addresses and
// phone numbers, with phones as 408-555-1234. Phones are kept as E.164
// (+14085551234), which Sheets reads as the number 14085551234, so they're
// written out here. A row is built by column name and laid out by the tab's
// own header row, so a tab made before a column was added still lines up.
// =============================================================================

import { wallParts } from './pool_time.ts';

type Person = { name?: string | null; phone?: string | null; email?: string | null; dob?: string | null };

/** A US number as 408-555-1234; anything else as typed. */
export function prettyPhone(raw: unknown): string {
  const s = String(raw ?? '').trim();
  const d = s.replace(/\D/g, '');
  const ten = d.length === 11 && d.startsWith('1') && (s.startsWith('+1') || !s.startsWith('+')) ? d.slice(1)
    : d.length === 10 && !s.startsWith('+') ? d : '';
  return ten ? `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}` : s;
}

/** Every US phone number inside free text ("Pat Lee — (408)-555-0003"). */
export function prettyPhonesIn(text: unknown): string {
  return String(text ?? '').replace(/(\+1[\s.-]?)?\(?\d{3}\)?[\s.-]*\d{3}[\s.-]*\d{4}\b/g, m => prettyPhone(m));
}

/** Typed text that Sheets would take as a formula (=, +, -, @) stays text. */
export function sheetSafe<T>(v: T): T | string {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? `'${v}` : v;
}

/** The season a signup is filed under: its membership year, or the year it was sent. */
export function driveSeason(app: { membership_year?: unknown; created_at?: unknown }, tz: string): string {
  const y = Number(app.membership_year);
  if (Number.isInteger(y) && y >= 2000 && y <= 2100) return String(y);
  return String(wallParts(new Date(String(app.created_at)), tz).year);
}

/** The adults besides the primary contact: name · phone · email. */
export function adultsCell(adults: Person[] | null | undefined, primaryName: unknown): string {
  const primary = String(primaryName ?? '').trim().toLowerCase();
  let skipped = false;
  return (adults ?? []).filter(a => {
    if (!skipped && primary && String(a.name ?? '').trim().toLowerCase() === primary) { skipped = true; return false; }
    return true;
  }).map(a => [a.name, a.phone ? prettyPhone(a.phone) : null, a.email].filter(x => x && String(x).trim()).join(' · '))
    .filter(Boolean).join('; ');
}

/** The children: name (born …). */
export function kidsCell(kids: Person[] | null | undefined): string {
  return (kids ?? []).filter(k => k.name && String(k.name).trim())
    .map(k => k.dob ? `${k.name} (born ${k.dob})` : String(k.name)).join('; ');
}

/** A row in the order of a tab's header row; a column the tab doesn't have is left out. */
export function rowByHeaders(headers: string[], record: Record<string, unknown>): unknown[] {
  return headers.map(h => (Object.prototype.hasOwnProperty.call(record, h) ? record[h] : '') ?? '');
}

// =============================================================================
// venmo.ts — the Venmo note and link (PLAN.md BC1, Doug 10/19)
// =============================================================================
// Every "Pay with Venmo" button opens Venmo to the club's handle with the
// amount and a note already filled in: "Cabana Club 2027 dues - Frevele -
// #K7Q2". The code (applications / party_bookings / keyfobs .venmo_code)
// is what the board looks for in Venmo, and it's shown next to the family on
// every board screen. js/venmo.js builds the same note and link in the app;
// scripts/test_venmo_codes.mjs checks the two agree.
// =============================================================================

/** "The Smith Family" → "Smith". */
export function familyShort(name: string | null | undefined): string {
  return String(name ?? '').trim().replace(/^the\s+/i, '').replace(/\s+family$/i, '').trim() || 'Family';
}

/** "Cabana Club 2027 dues - Frevele - #K7Q2" (kept short; Venmo shows it in the feed). */
export function venmoNote(a: { club: string; what: string; family: string | null | undefined; code: string | null | undefined }): string {
  const parts = [`${String(a.club || '').trim()} ${String(a.what || '').trim()}`.trim(), familyShort(a.family)];
  if (a.code) parts.push(`#${a.code}`);
  return parts.filter(Boolean).join(' - ').slice(0, 120);
}

/** Opens the Venmo app on a phone (Venmo's website on a computer), filled in. */
export function venmoLink(a: { handle: string; amountCents: number; note: string }): string {
  const h = String(a.handle || '').trim().replace(/^@+/, '');
  const amt = a.amountCents > 0 ? `&amount=${(a.amountCents / 100).toFixed(2)}` : '';
  return `https://venmo.com/${encodeURIComponent(h)}?txn=pay${amt}&note=${encodeURIComponent(a.note)}`;
}

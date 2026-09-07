// =============================================================================
// phone.ts — normalise a typed-in phone number to E.164
// =============================================================================
// Several columns hold whatever a human typed: gate_panels.contact_phone comes
// from a form that formats as "(925)-771-9074", and applications.primary_phone
// is whatever the applicant entered. Twilio rejects anything that is not
// E.164, and it fails per-message with a 21211 that nobody sees — the text
// simply never arrives.
//
// Deliberately conservative: anything not recognisably a US 10- or 11-digit
// number, or already E.164, returns null rather than a guess. A null is
// visible to the caller (which can log "no usable number"); a wrong number is
// not, and texts somebody else's phone.
// =============================================================================

export function toE164(raw: string | null | undefined): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.startsWith('+')) {
    const kept = '+' + s.slice(1).replace(/\D/g, '');
    return kept.length >= 8 ? kept : null;
  }
  const d = s.replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d.startsWith('1')) return `+${d}`;
  return null;
}

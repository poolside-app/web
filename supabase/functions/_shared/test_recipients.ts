// =============================================================================
// test_recipients.ts — addresses no real person has (PLAN.md BL3)
// =============================================================================
// The live tests make families with example.com emails and 555 numbers. Mail
// to example.com bounces, and bounces count against Poolside's sending
// reputation, which every club's receipts and sign-in emails depend on; a
// text to a 555 area code is refused by Twilio. So every send skips them,
// answering as before: an email as sent (Resend took them, then they
// bounced), a text as not sent (Twilio refused them), and still logged.
//
// Test addresses: the reserved example domains (example.com/.net/.org and
// anything under .example), .test, .invalid and localhost; and US numbers in
// the 555 area code, which doesn't exist. A 555 exchange in a real area code
// (925-555-1234) is a real number and still gets its text.
// =============================================================================

const RESERVED_DOMAIN = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost)$/i;

export function isTestEmail(to: unknown): boolean {
  const s = String(to ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('@');
  return at > 0 && RESERVED_DOMAIN.test(s.slice(at + 1));
}

export function isTestPhone(to: unknown): boolean {
  const d = String(to ?? '').replace(/\D/g, '');
  return (d.length >= 11 && d.startsWith('1555')) || (d.length === 10 && d.startsWith('555'));
}

export function isTestRecipient(to: unknown): boolean {
  return isTestEmail(to) || isTestPhone(to);
}

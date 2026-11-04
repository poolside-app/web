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

/** The adults besides the primary contact, one per line: name · phone · email. */
export function adultsCell(adults: Person[] | null | undefined, primaryName: unknown): string {
  const primary = String(primaryName ?? '').trim().toLowerCase();
  let skipped = false;
  return (adults ?? []).filter(a => {
    if (!skipped && primary && String(a.name ?? '').trim().toLowerCase() === primary) { skipped = true; return false; }
    return true;
  }).map(a => [a.name, a.phone ? prettyPhone(a.phone) : null, a.email].filter(x => x && String(x).trim()).join(' · '))
    .filter(Boolean).join('\n');
}

/** The children, by name. Birthdays are in the PDF (Doug, 11/3: "we dont need the DOB of the kids in there"). */
export function kidsCell(kids: Person[] | null | undefined): string {
  return (kids ?? []).filter(k => k.name && String(k.name).trim()).map(k => String(k.name).trim()).join(', ');
}

/** The family's working fob numbers, one per line, and how many wait to be
 *  issued. A family not approved yet shows the numbers it came with (the
 *  club's list, or what it typed) (PLAN.md BR4). */
export function fobsCell(active: string[], waiting: number, fromList: string | null): string {
  const nums = active.length ? active : String(fromList ?? '').split(/[,;\s]+/).map(x => x.trim()).filter(Boolean);
  return [...nums, ...(waiting > 0 ? [`${waiting} waiting to be issued`] : [])].join('\n');
}

type AppLike = Record<string, unknown>;

/** Where a signup, renewal or imported family stands (PLAN.md BR5). */
export function appStatus(app: AppLike): string {
  if (app.status === 'approved') return 'Approved';
  if (app.status === 'rejected') return 'Turned down';
  if (app.status === 'prefilled') return app.is_renewal === true ? 'Renewal not signed yet' : 'Imported, not signed yet';
  if (app.is_renewal === true && !(app.accepted_at && app.signature_primary)) return 'Renewal not signed yet';
  if (app.payment_status === 'paid') return 'Paid, waiting for approval';
  if (app.payment_status === 'pending_verify') return 'Venmo to check';
  return 'Not paid yet';
}

const PAID_BY: Record<string, string> = { stripe: 'Stripe', stripe_plan: 'Payment plan', venmo: 'Venmo', paypal: 'PayPal' };

/** One row of a season's roster, by column name (google_drive.ts SHEET_COLUMNS). */
export function rosterRecord(app: AppLike, ctx: {
  tz: string; tierLabel: string | null; pdfId: string | null;
  fobs: { active: string[]; waiting: number };
}): Record<string, unknown> {
  const typed = (v: unknown) => sheetSafe(String(v ?? ''));
  const sent = wallParts(new Date(String(app.created_at)), ctx.tz);
  const waivers = (app.waivers_accepted as Record<string, boolean> | null) ?? {};
  const acc = Object.values(waivers).filter(Boolean).length, tot = Object.keys(waivers).length;
  const method = String(app.payment_method ?? '');
  let verified = '';
  if (app.payment_status === 'paid') {
    const when = (app.verified_at ?? app.paid_at) as string | null;
    const d = when ? new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ctx.tz }) : '';
    verified = `${method.startsWith('stripe') ? 'Stripe' : 'Manual'} ✓${d ? ` ${d}` : ''}`;
  }
  return {
    'Family':            typed(app.family_name),
    'Status':            appStatus(app),
    'Type':              app.is_renewal === true ? 'Renewal' : 'New',
    'Primary Contact':   typed(app.primary_name),
    'Phone':             typed(prettyPhone(app.primary_phone)),
    'Email':             typed(app.primary_email),
    'Address':           typed(app.address),
    'City':              typed(app.city),
    'Zip':               typed(app.zip),
    'Other Adults':      typed(adultsCell(app.adults_json as Person[] | null, app.primary_name)),
    'Children':          typed(kidsCell(app.children_json as Person[] | null)),
    'Adults':            (app.num_adults as number | null) ?? 0,
    'Kids':              (app.num_kids as number | null) ?? 0,
    'Keyfobs':           fobsCell(ctx.fobs.active, ctx.fobs.waiting, app.household_id ? null : (app.prior_fob_number as string | null)),
    'Tier':              typed(ctx.tierLabel || app.tier_slug || ''),
    'Paid By':           PAID_BY[method] ?? typed(method),
    'Verified':          verified,
    'Policies':          tot > 0 ? `${acc}/${tot} ✓` : '—',
    'Emergency Contact': typed(prettyPhonesIn(app.emergency_contact)),
    'Submitted':         `=DATE(${sent.year},${sent.month},${sent.day})+TIME(${sent.hour},${sent.minute},${sent.second})`,
    'Application PDF':   ctx.pdfId ? `=HYPERLINK("https://drive.google.com/file/d/${ctx.pdfId}/view","📄 Open")` : '',
    'App ID':            String(app.id),
  };
}

/** A row in the order of a tab's header row; a column the tab doesn't have is left out. */
export function rowByHeaders(headers: string[], record: Record<string, unknown>): unknown[] {
  return headers.map(h => (Object.prototype.hasOwnProperty.call(record, h) ? record[h] : '') ?? '');
}

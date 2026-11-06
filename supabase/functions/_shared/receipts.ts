// =============================================================================
// receipts.ts — a real PDF receipt for every card payment (PLAN.md BZ)
// =============================================================================
// Doug 11/6: "the recpeit isn't like an official one... can you make a PDF of
// some sort?" Every card payment gets one receipt row, numbered per club per
// season ("2027-0001"), and the PDF is drawn from that row whenever it's
// needed: attached to the email the payment already sends, and copied to the
// family's folder in Drive (drive_family.ts). The row keeps what the receipt
// says, the club's name and address included, so it reads the same later.
// Venmo payments get none ("use the venmo reciept as your receipt"). Emailed
// only, never shown in the app; the board forwards a copy from Drive.
// Tested offline by scripts/test_receipts.mjs.
// =============================================================================

import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { fmtPoolDate, zoneOrDefault } from './pool_time.ts';

// deno-lint-ignore no-explicit-any
type Sb = any;
type Row = Record<string, unknown>;
export type ReceiptLine = { label: string; cents: number };
export type ReceiptInput = {
  tenantId: string;
  /** The Stripe payment (pi_…), or a test payment's id: one receipt per payment. */
  paymentRef: string;
  kind: 'membership' | 'renewal' | 'plan' | 'party' | 'keyfob' | 'program' | 'donation';
  /** What it was for, before the card fee. */
  lines: ReceiptLine[];
  /** What the card was charged. */
  totalCents: number;
  paidAt?: string;
  householdId?: string | null;
  applicationId?: string | null;
  familyName?: string | null;
  familyAddress?: string | null;
  payerName?: string | null;
  payerEmail?: string | null;
  /** "Visa ending 4242" */
  paidWith?: string | null;
  /** A plan: what's left to pay after this one. */
  balanceCents?: number | null;
  /** Who Stripe says paid, when Poolside doesn't know the family. */
  fallback?: { name?: string | null; email?: string | null };
};

const usd = (c: number) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "2027-0001" */
export function receiptNo(r: { season?: unknown; number?: unknown }): string {
  return `${r.season}-${String(r.number).padStart(4, '0')}`;
}
/** "2027 Receipt 0001.pdf", in the email and in Drive. */
export function receiptFileName(r: { season?: unknown; number?: unknown }): string {
  return `${r.season} Receipt ${String(r.number).padStart(4, '0')}.pdf`;
}

const BRANDS: Record<string, string> = {
  visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover',
  diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay',
};
/** "Visa ending 4242", from a PaymentIntent with its latest_charge expanded. */
export function cardLabel(pi: unknown): string {
  const card = ((((pi as Row | null)?.latest_charge as Row | undefined)?.payment_method_details as Row | undefined)?.card) as Row | undefined;
  if (!card?.last4) return 'Card';
  const brand = String(card.brand ?? '');
  const name = BRANDS[brand] ?? (brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card');
  return `${name} ending ${card.last4}`;
}
/** The card a payment was made with, asked of Stripe on the club's account. */
export async function stripeCardLabel(paymentIntentId: string | null | undefined, account: string | null | undefined,
  opts: { key?: string; fetchFn?: typeof fetch } = {}): Promise<string> {
  const id = String(paymentIntentId ?? '');
  if (!id.startsWith('pi_')) return id ? 'Test card' : 'Card';
  const key = opts.key ?? Deno.env.get('STRIPE_SECRET_KEY');
  if (!key) return 'Card';
  try {
    const r = await (opts.fetchFn ?? fetch)(`https://api.stripe.com/v1/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`, {
      headers: { Authorization: `Bearer ${key}`, ...(account ? { 'Stripe-Account': account } : {}) },
    });
    return r.ok ? cardLabel(await r.json()) : 'Card';
  } catch { return 'Card'; }
}

/** The club as its receipts show it: the address it entered, else its location. */
async function clubFor(sb: Sb, tenantId: string, now: Date) {
  const [{ data: t }, { data: s }] = await Promise.all([
    sb.from('tenants').select('display_name, slug, timezone').eq('id', tenantId).maybeSingle(),
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  const sv = (s?.value ?? {}) as Row;
  const club = (sv.club ?? {}) as Row;
  const { sellingYear } = await import('./membership_year.ts');
  return {
    name: String(t?.display_name || t?.slug || 'Your club'),
    address: String(club.address ?? '').trim() || String(club.location ?? '').trim(),
    tz: zoneOrDefault(t?.timezone),
    season: sellingYear(sv, now),
  };
}

/**
 * One receipt per payment: the same payment again (Stripe sends an event
 * twice) gets the receipt it already has. Nothing charged, no receipt. Who
 * paid comes from the signup or the family when the caller doesn't say.
 */
export async function issueReceipt(sb: Sb, input: ReceiptInput): Promise<Row | null> {
  if (!(input.totalCents > 0) || !input.paymentRef) return null;
  const mine = () => sb.from('receipts').select('*').eq('tenant_id', input.tenantId).eq('payment_ref', input.paymentRef).maybeSingle();
  const { data: had } = await mine();
  if (had) return had;

  const paidAt = input.paidAt ?? new Date().toISOString();
  const club = await clubFor(sb, input.tenantId, new Date(paidAt));
  let { familyName, familyAddress, payerName, payerEmail, householdId } = input;
  if (input.applicationId && (!familyName || !payerName || !payerEmail)) {
    const { data: a } = await sb.from('applications').select('family_name, address, primary_name, primary_email, household_id')
      .eq('id', input.applicationId).maybeSingle();
    if (a) {
      familyName ??= a.family_name; familyAddress ??= a.address; payerName ??= a.primary_name; payerEmail ??= a.primary_email;
      householdId ??= a.household_id;
    }
  }
  if (householdId && (!familyName || !familyAddress)) {
    const { data: h } = await sb.from('households').select('family_name, address').eq('id', householdId).maybeSingle();
    if (h) { familyName ??= h.family_name; familyAddress ??= h.address; }
  }
  if (householdId && (!payerName || !payerEmail)) {
    const { data: p } = await sb.from('household_members').select('name, email').eq('household_id', householdId)
      .eq('role', 'primary').eq('active', true).limit(1);
    if (p?.[0]) { payerName ??= p[0].name; payerEmail ??= p[0].email; }
  }
  payerName ??= input.fallback?.name ?? null;
  payerEmail ??= input.fallback?.email ?? null;
  const forCents = input.lines.reduce((n, l) => n + Math.round(Number(l.cents) || 0), 0);
  const row = {
    tenant_id: input.tenantId, season: club.season, payment_ref: input.paymentRef, kind: input.kind,
    household_id: householdId ?? null, application_id: input.applicationId ?? null,
    family_name: familyName ?? payerName ?? null, family_address: familyAddress ?? null,
    payer_name: payerName ?? familyName ?? null, payer_email: payerEmail ?? null,
    lines: input.lines.map(l => ({ label: String(l.label), cents: Math.round(Number(l.cents) || 0) })),
    card_fee_cents: Math.max(0, input.totalCents - forCents), total_cents: input.totalCents,
    paid_with: input.paidWith ?? 'Card', balance_cents: input.balanceCents ?? null,
    club_name: club.name, club_address: club.address, tz: club.tz, paid_at: paidAt,
  };
  // The next number; two payments at once both try it, and one tries again.
  for (let tries = 0; tries < 5; tries++) {
    const { data: last } = await sb.from('receipts').select('number').eq('tenant_id', input.tenantId).eq('season', club.season)
      .order('number', { ascending: false }).limit(1);
    const number = Number(last?.[0]?.number ?? 0) + 1;
    const { data, error } = await sb.from('receipts').insert({ ...row, number }).select('*').single();
    if (!error && data) {
      copyLater(sb, input.tenantId);
      return data;
    }
    const { data: theirs } = await mine();
    if (theirs) return theirs;
  }
  console.error('receipt: no number after 5 tries', input.tenantId, input.paymentRef);
  return null;
}

/** The newest receipt for a signup: its welcome or renewal email carries it. */
export async function latestReceipt(sb: Sb, applicationId: string): Promise<Row | null> {
  // One signup's receipts are all in its season, so the highest number is the newest.
  const { data } = await sb.from('receipts').select('*').eq('application_id', applicationId)
    .order('number', { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

// Copied to the family's Drive folder after the payment's work is done; the
// nightly Drive run catches any that fail.
function copyLater(sb: Sb, tenantId: string) {
  const id = Deno.env.get('GOOGLE_CLIENT_ID'), secret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  if (!id || !secret) return;
  const job = import('./drive_family.ts')
    .then(m => m.backupReceipts(sb, tenantId, { googleClientId: id, googleClientSecret: secret }))
    .catch(e => console.error('receipt to Drive (the nightly run tries again):', (e as Error).message));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job);
}

const PAGE_W = 612, PAGE_H = 792, MARGIN = 60;
const COLOR_TEXT = rgb(0.06, 0.09, 0.16), COLOR_BLUE = rgb(0.04, 0.23, 0.36), COLOR_MUTED = rgb(0.39, 0.45, 0.55);
// Helvetica covers Latin-1 only: swap the usual offenders, drop the rest.
const SUBS: Record<string, string> = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*' };
const clean = (s: unknown) => {
  let out = String(s ?? '');
  for (const [a, b] of Object.entries(SUBS)) out = out.split(a).join(b);
  return Array.from(out).filter(c => c.codePointAt(0)! >= 0x20 && c.codePointAt(0)! <= 0xFF).join('');
};

/** One letter-size page: the club, the receipt number and day, who paid, what
 *  for, the card fee, the total, the card, and for a plan what's left. */
export async function renderReceiptPdf(r: Row): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  const text = (s: unknown, o: { size?: number; b?: boolean; color?: ReturnType<typeof rgb>; x?: number; right?: boolean } = {}) => {
    const size = o.size ?? 11, font = o.b ? bold : reg, str = clean(s);
    const x = o.right ? PAGE_W - MARGIN - font.widthOfTextAtSize(str, size) : (o.x ?? MARGIN);
    page.drawText(str, { x, y: y - size, size, font, color: o.color ?? COLOR_TEXT });
  };
  const down = (n: number) => { y -= n; };
  const rule = () => { page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: COLOR_MUTED }); };
  const tz = zoneOrDefault(r.tz);

  text(r.club_name, { size: 18, b: true, color: COLOR_BLUE }); down(24);
  if (r.club_address) { text(r.club_address, { size: 10, color: COLOR_MUTED }); down(16); }
  down(18);
  text(`Receipt ${receiptNo(r)}`, { size: 14, b: true });
  text(fmtPoolDate(String(r.paid_at), tz, { month: 'long', day: 'numeric', year: 'numeric' }), { size: 11, right: true });
  down(30);
  text('Received from', { size: 9, b: true, color: COLOR_MUTED }); down(14);
  if (r.payer_name) { text(r.payer_name); down(15); }
  if (r.payer_email) { text(r.payer_email, { color: COLOR_MUTED }); down(15); }
  down(14);
  rule(); down(12);
  const lines = (Array.isArray(r.lines) ? r.lines : []) as ReceiptLine[];
  for (const l of lines) { text(l.label); text(usd(Number(l.cents)), { right: true }); down(18); }
  if (Number(r.card_fee_cents) > 0) { text('Card fee', { color: COLOR_MUTED }); text(usd(Number(r.card_fee_cents)), { right: true, color: COLOR_MUTED }); down(18); }
  down(2); rule(); down(10);
  text('Total paid', { b: true, size: 12 }); text(usd(Number(r.total_cents)), { b: true, size: 12, right: true }); down(26);
  text(`Paid by ${r.paid_with || 'card'}`, { color: COLOR_MUTED }); down(16);
  if (r.balance_cents != null) {
    text(Number(r.balance_cents) > 0 ? `Left to pay on your plan: ${usd(Number(r.balance_cents))}` : 'Paid in full.', { color: COLOR_MUTED });
    down(16);
  }
  down(24);
  text(`Thank you from ${r.club_name}.`, { size: 11, color: COLOR_BLUE });
  doc.setTitle(`Receipt ${receiptNo(r)}`);
  doc.setAuthor(clean(r.club_name));
  return await doc.save();
}

/** The receipt as an email attachment. */
export async function receiptAttachment(r: Row): Promise<{ filename: string; content: string; contentType: string }> {
  const { bytesToBase64 } = await import('./send_email.ts');
  return { filename: receiptFileName(r), content: bytesToBase64(await renderReceiptPdf(r)), contentType: 'application/pdf' };
}

/** The receipt for an email's attachments: none if it can't be drawn, so a
 *  receipt never stops the email itself. */
export async function receiptFiles(r: Row | null): Promise<Array<{ filename: string; content: string; contentType: string }>> {
  if (!r) return [];
  try { return [await receiptAttachment(r)]; }
  catch (e) { console.error('receipt PDF (the email goes without it):', (e as Error).message); return []; }
}

/** "Payment receipt": for card payments with no email of their own (keyfobs,
 *  programs, donations, catching up or reinstating a plan). */
export async function emailReceipt(sb: Sb, r: Row | null): Promise<void> {
  if (!r?.payer_email) return;
  try {
    const { renderAndSend } = await import('./email_template.ts');
    await renderAndSend(sb, {
      tenantId: String(r.tenant_id), templateKey: 'payment_receipt', to: String(r.payer_email),
      variables: {
        family_name: String(r.family_name ?? r.payer_name ?? ''), primary_name: String(r.payer_name ?? ''),
        amount: usd(Number(r.total_cents)), what: ((r.lines ?? []) as ReceiptLine[]).map(l => l.label).join(', '),
        receipt_no: receiptNo(r),
      },
      attachments: await receiptFiles(r),
    });
  } catch (e) { console.error('receipt email (non-fatal):', (e as Error).message); }
}

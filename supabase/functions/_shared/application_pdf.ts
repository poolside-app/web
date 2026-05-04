// =============================================================================
// application_pdf.ts — render a membership application as a PDF (pdf-lib)
// =============================================================================
// Frozen at submit time — this is the legal-evidence snapshot. Never re-rendered
// after the fact. Captures: applicant data, accepted policies, all per-adult
// signatures (embedded PNGs from the apply form's data URLs), guardian signature.
//
// Layout: letter size (612×792 pts), single column, top-down. Multi-page if
// the content overflows (handled by the y-cursor reset logic below).
// =============================================================================

import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const PAGE_W = 612;   // letter width in pts (8.5 in)
const PAGE_H = 792;   // letter height in pts (11 in)
const MARGIN = 54;    // 0.75 in margins
const COLOR_TEXT = rgb(0.06, 0.09, 0.16);
const COLOR_BLUE = rgb(0.04, 0.23, 0.36);
const COLOR_MUTED = rgb(0.39, 0.45, 0.55);

export type AdultRow = {
  name?: string;
  dob?: string | null;
  phone?: string | null;
  email?: string | null;
  signature_url?: string | null;
};
export type ChildRow = { name?: string; dob?: string | null };

// Full policy record — body text is rendered inline so the PDF is a complete
// legal-evidence document (the applicant agreed to THIS exact text, not
// "policy slug X" which could later be edited).
export type PolicyForPdf = {
  slug: string;
  title: string;
  body: string;
  accepted: boolean;
  accepted_at?: string | null;     // ISO timestamp; falls back to app.submitted_at
  sort_order?: number;
};

export type ApplicationForPdf = {
  id: string;
  tenant_display_name: string;
  submitted_at: string;
  family_name: string;
  primary_name: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  address: string | null;
  city: string | null;
  zip: string | null;
  emergency_contact: string | null;
  num_adults: number | null;
  num_kids: number | null;
  tier_slug: string | null;
  tier_label?: string | null;
  payment_method: string | null;
  adults_json: AdultRow[];
  children_json: ChildRow[];
  waivers_accepted: Record<string, boolean>;
  policies_titles: Record<string, string>;   // slug → human title (legacy fallback)
  policies?: PolicyForPdf[];                 // full policy bodies for legal-evidence rendering
  signature_primary?: string | null;          // legacy fallback
  signature_guardian?: string | null;
};

// Decode a data URL ("data:image/png;base64,...") into a Uint8Array. Returns
// null for empty/invalid input so callers can render "(unsigned)" gracefully.
function decodeDataUrl(s: string | null | undefined): Uint8Array | null {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^data:image\/png;base64,(.+)$/i);
  if (!m) return null;
  try {
    const bin = atob(m[1]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export async function renderApplicationPdf(app: ApplicationForPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontReg  = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // pdf-lib's StandardFonts (Helvetica) use WinAnsi encoding which only
  // covers Latin-1 + a few extras. ANY emoji, smart quote, em-dash, ✓, →,
  // etc. crashes with 'WinAnsi cannot encode'. Strip non-WinAnsi chars
  // before rendering. Replaces common offenders with ASCII equivalents
  // and drops anything else.
  const SUBSTITUTIONS: Record<string, string> = {
    '–': '-',  '—': '-',           // en/em dash
    '‘': "'",  '’': "'",           // smart single quotes
    '“': '"',  '”': '"',           // smart double quotes
    '…': '...',                          // ellipsis
    '•': '*',                            // bullet
    '→': '->', '←': '<-',          // arrows
    '✓': '[X]','✗': '[ ]',         // check / x
    '…': '...',                          // ellipsis
    ' ': ' ',                            // nbsp
  };
  const sanitize = (s: string): string => {
    let out = String(s ?? '');
    for (const [from, to] of Object.entries(SUBSTITUTIONS)) {
      out = out.split(from).join(to);
    }
    // Drop any remaining char outside WinAnsi (codepoint > 0xFF) so pdf-lib
    // doesn't throw. Loses emoji/CJK but the alternative is a crashed PDF.
    return Array.from(out).filter(c => c.codePointAt(0)! <= 0xFF).join('');
  };

  const text = (s: string, opts: { x?: number; size?: number; bold?: boolean; color?: ReturnType<typeof rgb> } = {}) => {
    const x = opts.x ?? MARGIN;
    const size = opts.size ?? 10;
    const font = opts.bold ? fontBold : fontReg;
    const color = opts.color ?? COLOR_TEXT;
    page.drawText(sanitize(String(s ?? '')), { x, y, size, font, color });
  };
  const ensureSpace = (needed: number) => {
    if (y - needed < MARGIN) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
  };
  const moveDown = (delta: number) => {
    y -= delta;
    ensureSpace(0);
  };
  const sectionHeading = (s: string) => {
    moveDown(14);
    ensureSpace(20);
    text(s.toUpperCase(), { size: 9, bold: true, color: COLOR_BLUE });
    moveDown(4);
    page.drawLine({
      start: { x: MARGIN, y },
      end:   { x: PAGE_W - MARGIN, y },
      thickness: 0.5,
      color: COLOR_BLUE,
    });
    moveDown(10);
  };
  const kv = (label: string, value: string | null | undefined) => {
    if (value == null || String(value).trim() === '') return;
    ensureSpace(14);
    text(label + ':', { x: MARGIN, size: 9, bold: true, color: COLOR_MUTED });
    text(String(value), { x: MARGIN + 130, size: 10 });
    moveDown(13);
  };

  // ── Header ────────────────────────────────────────────────────────────
  text(app.tenant_display_name, { size: 16, bold: true, color: COLOR_BLUE });
  moveDown(20);
  text('Membership Application', { size: 13, bold: true });
  moveDown(14);
  text(`Submitted: ${app.submitted_at}`, { size: 9, color: COLOR_MUTED });
  moveDown(11);
  text(`Application ID: ${app.id}`, { size: 9, color: COLOR_MUTED });
  moveDown(8);

  // ── Family info ───────────────────────────────────────────────────────
  sectionHeading('Family');
  kv('Family name', app.family_name);
  kv('Primary contact', app.primary_name);
  kv('Primary email', app.primary_email);
  kv('Primary phone', app.primary_phone);
  kv('Address', app.address);
  kv('City', app.city);
  kv('ZIP', app.zip);
  kv('Emergency contact', app.emergency_contact);

  // ── Tier + payment ────────────────────────────────────────────────────
  sectionHeading('Tier & payment');
  kv('Tier', app.tier_label || app.tier_slug || '(admin assigns on approval)');
  kv('Payment method', app.payment_method);
  kv('Adults', app.num_adults != null ? String(app.num_adults) : null);
  kv('Children', app.num_kids != null ? String(app.num_kids) : null);

  // ── Adults table ──────────────────────────────────────────────────────
  if (app.adults_json && app.adults_json.length) {
    sectionHeading('Adults');
    app.adults_json.forEach((a, i) => {
      ensureSpace(48);
      text(`${i + 1}. ${a.name || '(unnamed)'}`, { size: 11, bold: true });
      moveDown(13);
      const meta = [
        a.dob ? `DOB ${a.dob}` : null,
        a.phone ? `Phone ${a.phone}` : null,
        a.email ? `Email ${a.email}` : null,
      ].filter(Boolean).join(' · ');
      if (meta) {
        text(meta, { size: 9, color: COLOR_MUTED, x: MARGIN + 14 });
        moveDown(12);
      }
      moveDown(2);
    });
  }

  // ── Children table ────────────────────────────────────────────────────
  if (app.children_json && app.children_json.length) {
    sectionHeading('Children');
    app.children_json.forEach((c, i) => {
      ensureSpace(14);
      text(`${i + 1}. ${c.name || '(unnamed)'}${c.dob ? ` - DOB ${c.dob}` : ''}`, { size: 10 });
      moveDown(13);
    });
  }

  // ── Policies (full legal-evidence text + acceptance) ─────────────────
  // For each policy, render: title + ACCEPTED/NOT-ACCEPTED status + the
  // verbatim body text the applicant agreed to. This is the legal record:
  // the contract IS the document, not a hyperlink that might rot.
  const policyMaxWidth = PAGE_W - MARGIN * 2 - 14;  // leave room for body indent

  // Greedy word-wrap. pdf-lib has no built-in wrap. font.widthOfTextAtSize
  // is exact; we measure each candidate line and break before overflow.
  const wrapText = (s: string, size: number): string[] => {
    const sourceLines = sanitize(s).split(/\r?\n/);
    const out: string[] = [];
    for (const para of sourceLines) {
      if (!para.trim()) { out.push(''); continue; }   // preserve blank-line gaps
      const words = para.split(/(\s+)/);              // keep whitespace as tokens
      let cur = '';
      for (const tok of words) {
        const cand = cur + tok;
        if (fontReg.widthOfTextAtSize(cand, size) <= policyMaxWidth) {
          cur = cand;
        } else {
          if (cur.trim()) out.push(cur.trimEnd());
          cur = tok.replace(/^\s+/, '');
        }
      }
      if (cur.trim()) out.push(cur.trimEnd());
    }
    return out;
  };

  // Determine which policies to render. Prefer the full `policies` array
  // (with bodies). Legacy callers passing only `policies_titles` still get
  // a list rendered, just without bodies.
  const policiesFull: PolicyForPdf[] = (app.policies && app.policies.length)
    ? [...app.policies].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    : Object.entries(app.policies_titles ?? {}).map(([slug, title]) => ({
        slug, title, body: '',
        accepted: !!app.waivers_accepted?.[slug],
      }));

  if (policiesFull.length) {
    sectionHeading('Policies — verbatim text & acceptance record');
    policiesFull.forEach((p, idx) => {
      // Always start each policy with at least its title + status visible.
      ensureSpace(38);

      // Policy heading
      text(`${idx + 1}. ${p.title}`, { size: 12, bold: true, color: COLOR_BLUE });
      moveDown(15);

      // Acceptance status badge
      const accepted = p.accepted || !!app.waivers_accepted?.[p.slug];
      const stamp = accepted
        ? `[X] ACCEPTED${p.accepted_at ? ` on ${p.accepted_at}` : (app.submitted_at ? ` on ${app.submitted_at}` : '')}`
        : `[ ] NOT ACCEPTED`;
      text(stamp, { size: 9, bold: true, color: accepted ? COLOR_BLUE : COLOR_MUTED });
      moveDown(14);

      // Full body (verbatim text the applicant agreed to)
      if (p.body && p.body.trim()) {
        const bodySize = 9;
        const lineH = 12;
        const lines = wrapText(p.body, bodySize);
        for (const ln of lines) {
          ensureSpace(lineH);
          if (ln === '') {
            // blank line — paragraph gap
            moveDown(lineH * 0.6);
          } else {
            text(ln, { size: bodySize, x: MARGIN + 14 });
            moveDown(lineH);
          }
        }
      } else {
        text('(no policy text on file)', { size: 9, x: MARGIN + 14, color: COLOR_MUTED });
        moveDown(12);
      }
      moveDown(8);
    });
  }

  // ── Signatures ────────────────────────────────────────────────────────
  sectionHeading('Signatures');
  for (let i = 0; i < (app.adults_json ?? []).length; i++) {
    const a = app.adults_json[i];
    const sig = decodeDataUrl(a.signature_url);
    ensureSpace(80);
    text(`Adult #${i + 1}: ${a.name || '(unnamed)'}`, { size: 10, bold: true });
    moveDown(14);
    if (sig) {
      try {
        const png = await doc.embedPng(sig);
        const ratio = png.height ? png.width / png.height : 3;
        const drawH = 50;
        const drawW = Math.min(220, drawH * ratio);
        page.drawImage(png, { x: MARGIN + 14, y: y - drawH, width: drawW, height: drawH });
        moveDown(drawH + 6);
      } catch {
        text('(signature image could not be embedded)', { x: MARGIN + 14, size: 9, color: COLOR_MUTED });
        moveDown(14);
      }
    } else {
      text('(no signature on file)', { x: MARGIN + 14, size: 9, color: COLOR_MUTED });
      moveDown(14);
    }
  }
  // Guardian signature (only if minors present)
  const guardianSig = decodeDataUrl(app.signature_guardian);
  if (guardianSig) {
    ensureSpace(80);
    text('Parent / guardian (on behalf of all minors)', { size: 10, bold: true });
    moveDown(14);
    try {
      const png = await doc.embedPng(guardianSig);
      const ratio = png.height ? png.width / png.height : 3;
      const drawH = 50;
      const drawW = Math.min(220, drawH * ratio);
      page.drawImage(png, { x: MARGIN + 14, y: y - drawH, width: drawW, height: drawH });
      moveDown(drawH + 6);
    } catch {
      text('(guardian signature could not be embedded)', { x: MARGIN + 14, size: 9, color: COLOR_MUTED });
      moveDown(14);
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────
  ensureSpace(28);
  moveDown(20);
  text(
    `This document was generated automatically at the time of submission and is preserved as the immutable record of the applicant's signature and acknowledged policies. Generated by Poolside.`,
    { size: 8, color: COLOR_MUTED },
  );

  return await doc.save();
}

// =============================================================================
// household_member_pdf.ts — legal-evidence PDF for a member added post-apply
// =============================================================================
// The primary household contact can add additional family members from /m/
// after the household is approved. The original `application_pdf.ts` doc
// captures the household at apply time; this helper produces a smaller
// addendum PDF for each subsequent add. Frozen at add-time, single source
// of legal record for that addition: name + role + accepted policy text +
// signature (adult: own; minor: guardian's).
// =============================================================================

import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const COLOR_TEXT = rgb(0.06, 0.09, 0.16);
const COLOR_BLUE = rgb(0.04, 0.23, 0.36);
const COLOR_MUTED = rgb(0.39, 0.45, 0.55);

export type AddedMemberPolicy = {
  slug: string;
  title: string;
  body: string;
  accepted: boolean;
  sort_order?: number;
};

export type AddedMemberForPdf = {
  member_id: string;
  tenant_display_name: string;
  added_at: string;            // pre-formatted human string
  family_name: string;
  primary_name: string;
  member_name: string;
  member_role: 'adult' | 'teen' | 'child';
  member_dob?: string | null;
  member_email?: string | null;
  member_phone?: string | null;
  policies: AddedMemberPolicy[];
  signature_data_url?: string | null;       // adult: their own
  guardian_signature_data_url?: string | null;  // minor: primary's
};

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

export async function renderAddedMemberPdf(d: AddedMemberForPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontReg  = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const SUBSTITUTIONS: Record<string, string> = {
    '–': '-',  '—': '-',
    '‘': "'",  '’': "'",
    '“': '"',  '”': '"',
    '…': '...',
    '•': '*',
    '→': '->', '←': '<-',
    '✓': '[X]','✗': '[ ]',
    ' ': ' ',
  };
  const sanitize = (s: string): string => {
    let out = String(s ?? '');
    for (const [from, to] of Object.entries(SUBSTITUTIONS)) {
      out = out.split(from).join(to);
    }
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

  const policyMaxWidth = PAGE_W - MARGIN * 2 - 14;
  const wrapText = (s: string, size: number): string[] => {
    const sourceLines = sanitize(s).split(/\r?\n/);
    const out: string[] = [];
    for (const para of sourceLines) {
      if (!para.trim()) { out.push(''); continue; }
      const words = para.split(/(\s+)/);
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

  // ── Header ──────────────────────────────────────────────────────────
  text(d.tenant_display_name, { size: 16, bold: true, color: COLOR_BLUE });
  moveDown(20);
  text('Household Member Added', { size: 13, bold: true });
  moveDown(14);
  text(`Added: ${d.added_at}`, { size: 9, color: COLOR_MUTED });
  moveDown(11);
  text(`Member ID: ${d.member_id}`, { size: 9, color: COLOR_MUTED });
  moveDown(8);

  // ── Household + new member ──────────────────────────────────────────
  sectionHeading('Household');
  kv('Family name', d.family_name);
  kv('Primary contact', d.primary_name);

  sectionHeading('New member');
  kv('Name', d.member_name);
  kv('Role', d.member_role);
  kv('Date of birth', d.member_dob || null);
  kv('Email', d.member_email || null);
  kv('Phone', d.member_phone || null);

  // ── Policies ────────────────────────────────────────────────────────
  if (d.policies && d.policies.length) {
    sectionHeading('Policies — verbatim text & acceptance record');
    const sorted = [...d.policies].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    sorted.forEach((p, idx) => {
      ensureSpace(38);
      text(`${idx + 1}. ${p.title}`, { size: 12, bold: true, color: COLOR_BLUE });
      moveDown(15);
      const stamp = p.accepted
        ? `[X] ACCEPTED on ${d.added_at}`
        : `[ ] NOT ACCEPTED`;
      text(stamp, { size: 9, bold: true, color: p.accepted ? COLOR_BLUE : COLOR_MUTED });
      moveDown(14);
      if (p.body && p.body.trim()) {
        const bodySize = 9;
        const lineH = 12;
        const lines = wrapText(p.body, bodySize);
        for (const ln of lines) {
          ensureSpace(lineH);
          if (ln === '') {
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

  // ── Signature ───────────────────────────────────────────────────────
  sectionHeading('Signature');
  const isMinor = d.member_role !== 'adult';
  const sigBytes = decodeDataUrl(isMinor ? d.guardian_signature_data_url : d.signature_data_url);
  ensureSpace(80);
  text(
    isMinor
      ? `Parent / guardian (${d.primary_name}) on behalf of ${d.member_name}`
      : `${d.member_name}`,
    { size: 10, bold: true },
  );
  moveDown(14);
  if (sigBytes) {
    try {
      const png = await doc.embedPng(sigBytes);
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

  // ── Footer ──────────────────────────────────────────────────────────
  ensureSpace(28);
  moveDown(20);
  text(
    `This document was generated automatically when the primary household contact added a new member to their household and is preserved as the immutable record of the acknowledged policies and signature. Generated by Poolside.`,
    { size: 8, color: COLOR_MUTED },
  );

  return await doc.save();
}

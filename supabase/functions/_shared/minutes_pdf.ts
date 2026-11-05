// =============================================================================
// minutes_pdf.ts — board minutes as a PDF for the club's Drive (PLAN.md BV2)
// =============================================================================
// Doug, 11/5: "we should probably backup the meeting minutes as well in the
// google drive". The same things the members' page shows (governance.html):
// the meeting, attendance, notes, motions and follow-ups. A draft says so at
// the top; an approved copy says when and who approved it. Times are the
// pool's. Letter size, one column, more pages as needed.
// =============================================================================

import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { fmtPoolDate, fmtPoolDay, fmtPoolTime } from './pool_time.ts';

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const COLOR_TEXT = rgb(0.06, 0.09, 0.16);
const COLOR_BLUE = rgb(0.04, 0.23, 0.36);
const COLOR_MUTED = rgb(0.39, 0.45, 0.55);
const COLOR_DRAFT = rgb(0.6, 0.25, 0.02);

type Attendee = { name?: string | null; role?: string | null };
type Vote = { motion?: string | null; proposed_by?: string | null; seconded_by?: string | null; yes?: number; no?: number; abstain?: number; outcome?: string | null; notes?: string | null };
type FollowUp = { description?: string | null; assigned_to?: string | null; due_date?: string | null; status?: string | null };

export type MinutesForPdf = {
  club: string;
  tz: string;
  state: 'draft' | 'approved';
  amended?: boolean;
  approved_at?: string | null;
  approvers?: Array<{ name: string; on_behalf_by?: string | null }>;
  title?: string | null;
  meeting_date?: string | null;
  location?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
  visibility?: string | null;
  notes_md?: string | null;
  attendees_json?: unknown;
  votes_json?: unknown;
  follow_ups_json?: unknown;
};

/** "2026-11-05 November board meeting - draft.pdf", "… - approved 2026-11-12.pdf",
 *  "… - amended, approved 2026-11-20.pdf". Slashes and the like become dashes. */
export function minutesFileName(
  m: { meeting_date?: unknown; title?: unknown },
  kind: 'draft' | 'approved',
  opts: { approvedDay?: string; amended?: boolean } = {},
): string {
  const title = String(m.title ?? '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Board meeting';
  const end = kind === 'draft' ? 'draft' : `${opts.amended ? 'amended, approved' : 'approved'} ${opts.approvedDay ?? ''}`.trim();
  return `${String(m.meeting_date ?? '')} ${title} - ${end}.pdf`.trim();
}

const OUTCOME: Record<string, string> = { passed: 'Passed', failed: 'Failed', tabled: 'Tabled', pending: 'Pending' };

export async function renderMinutesPdf(d: MinutesForPdf): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  // Helvetica covers Latin-1 only (see application_pdf.ts): swap the usual
  // offenders and drop the rest, emoji included, rather than crash.
  const SUBS: Record<string, string> = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '•': '*', '→': '->', '✓': 'done', ' ': ' ', ' ': ' ' };
  const clean = (s: unknown) => {
    let out = String(s ?? '');
    for (const [a, b] of Object.entries(SUBS)) out = out.split(a).join(b);
    return Array.from(out).filter(c => c === '\n' || (c.codePointAt(0)! >= 0x20 && c.codePointAt(0)! <= 0xFF)).join('');
  };
  const ensureSpace = (h: number) => {
    if (y - h < MARGIN) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
  };
  // Wrapped lines, each its own drawText; a blank line keeps its space.
  const para = (s: unknown, o: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; gap?: number } = {}) => {
    const size = o.size ?? 10, font = o.bold ? fontBold : fontReg, x = o.x ?? MARGIN;
    const width = PAGE_W - MARGIN - x, lead = size + 3;
    for (const raw of clean(s).split('\n')) {
      const words = raw.split(/\s+/).filter(Boolean);
      if (!words.length) { y -= lead; continue; }
      let line = '';
      const flush = () => { ensureSpace(lead); page.drawText(line, { x, y: y - size, size, font, color: o.color ?? COLOR_TEXT }); y -= lead; line = ''; };
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (line && font.widthOfTextAtSize(next, size) > width) { flush(); line = w; } else line = next;
      }
      if (line) flush();
    }
    y -= o.gap ?? 0;
  };
  const heading = (s: string) => {
    y -= 10;
    ensureSpace(26);
    page.drawText(s.toUpperCase(), { x: MARGIN, y: y - 9, size: 9, font: fontBold, color: COLOR_BLUE });
    y -= 13;
    page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: COLOR_BLUE });
    y -= 8;
  };

  // ── The meeting ───────────────────────────────────────────────────────
  para(d.club, { size: 16, bold: true, color: COLOR_BLUE, gap: 4 });
  para(d.title || 'Board meeting', { size: 13, bold: true, gap: 2 });
  const day = d.meeting_date ? fmtPoolDay(d.meeting_date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) : '';
  const times = d.started_at && d.ended_at ? `${fmtPoolTime(d.started_at, d.tz)} - ${fmtPoolTime(d.ended_at, d.tz)}`
    : d.started_at ? `started ${fmtPoolTime(d.started_at, d.tz)}` : '';
  para([day, d.location, times].filter(Boolean).join(' · '), { size: 10, color: COLOR_MUTED, gap: 6 });

  if (d.state === 'draft') {
    para('Draft, not approved yet. The approved minutes are saved as their own file.', { size: 10, bold: true, color: COLOR_DRAFT });
  } else {
    const when = d.approved_at ? fmtPoolDate(d.approved_at, d.tz, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    const who = (d.approvers ?? []).map(a => a.on_behalf_by ? `${a.name} (approved for them by ${a.on_behalf_by})` : a.name);
    para(`${d.amended ? 'Amended minutes, approved' : 'Approved'} ${when}${who.length ? ` by ${who.join(', ')}` : ''}.`, { size: 10, bold: true, color: COLOR_BLUE });
  }
  para(d.visibility === 'private' ? 'Board only: members don\'t see these minutes.'
    : d.state === 'draft' ? 'Members can read them once they\'re approved.' : 'Members can read these minutes in the app.', { size: 9, color: COLOR_MUTED });

  // ── Attendance ────────────────────────────────────────────────────────
  const attendees = (Array.isArray(d.attendees_json) ? d.attendees_json as Attendee[] : []).filter(a => a && a.name);
  if (attendees.length) {
    heading(`Attendance - ${attendees.length}`);
    for (const a of attendees) para(a.role ? `${a.name} (${a.role})` : a.name);
  }

  // ── Notes ─────────────────────────────────────────────────────────────
  if (d.notes_md && d.notes_md.trim()) {
    heading('Notes');
    para(d.notes_md.trim());
  }

  // ── Motions & votes ───────────────────────────────────────────────────
  const votes = Array.isArray(d.votes_json) ? d.votes_json as Vote[] : [];
  if (votes.length) {
    heading('Motions & votes');
    votes.forEach((v, i) => {
      para(`${i + 1}. ${v.motion || '(no motion written)'}`, { bold: true });
      const count = (v.yes || v.no || v.abstain) ? `${v.yes || 0}-${v.no || 0}${v.abstain ? ` (${v.abstain} abstain)` : ''}` : null;
      const meta = [
        v.proposed_by ? `Proposed by ${v.proposed_by}` : null,
        v.seconded_by ? `Seconded by ${v.seconded_by}` : null,
        count,
        OUTCOME[String(v.outcome ?? 'pending')] ?? v.outcome,
      ].filter(Boolean).join(' · ');
      para(meta, { size: 9, color: COLOR_MUTED, x: MARGIN + 14 });
      if (v.notes) para(v.notes, { size: 9, x: MARGIN + 14 });
      y -= 4;
    });
  }

  // ── Follow-ups ────────────────────────────────────────────────────────
  const fu = (Array.isArray(d.follow_ups_json) ? d.follow_ups_json as FollowUp[] : []).filter(f => f && f.description);
  if (fu.length) {
    heading('Follow-ups');
    for (const f of fu) {
      const bits = [
        f.assigned_to ? `-> ${f.assigned_to}` : null,
        f.due_date ? `due ${fmtPoolDay(f.due_date, { weekday: 'short', month: 'short', day: 'numeric' })}` : null,
        f.status === 'done' ? '(done)' : f.status === 'cancelled' ? '(skipped)' : null,
      ].filter(Boolean).join(' ');
      para(`* ${f.description}${bits ? ` ${bits}` : ''}`);
    }
  }

  doc.setTitle(clean(`${d.title || 'Board meeting'} ${d.meeting_date ?? ''}`.trim()));
  doc.setAuthor(clean(d.club));
  doc.setCreator('Poolside');
  return await doc.save();
}

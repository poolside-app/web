// =============================================================================
// sheet_look.ts — how the Drive roster and Parties tabs look (PLAN.md BR)
// =============================================================================
// Doug, 2026-11-03: "the format looks kinda lame.. spice it up a little..
// auto expand the width… to ensure you can see all the info". Each run sets:
// columns as wide as their longest line, lists wrapped one per line, the
// header and first column frozen, colored chips on status columns, banded
// rows, a sun-colored line under the header, and the tab's color.
//
// The whole look is set again on every run, so it's the same on a tab made
// before. What an earlier run added (banding, color rules) is removed first,
// or the rules would pile up night after night. That also clears any color
// rule the board added to a Poolside tab.
// =============================================================================

type Rgb = { red: number; green: number; blue: number };
const hex = (h: string): Rgb => ({
  red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255,
});
export const BRAND_BLUE = hex('#0a3b5c');
export const SUN        = hex('#f59e0b');
const BAND_LIGHT = hex('#f4f8fb');
const TEXT_DARK  = hex('#0f172a');
const WHITE      = hex('#ffffff');

export type ChipColor = 'green' | 'amber' | 'red' | 'blue' | 'purple' | 'gray';
/** Color a cell by how its text starts (or what it contains). First match wins. */
export type Chip = { startsWith?: string; contains?: string; color: ChipColor };
const CHIP: Record<ChipColor, { bg: Rgb; fg: Rgb }> = {
  green:  { bg: hex('#dcfce7'), fg: hex('#166534') },
  amber:  { bg: hex('#fef3c7'), fg: hex('#92400e') },
  red:    { bg: hex('#fee2e2'), fg: hex('#991b1b') },
  blue:   { bg: hex('#dbeafe'), fg: hex('#1e40af') },
  purple: { bg: hex('#ede9fe'), fg: hex('#5b21b6') },
  gray:   { bg: hex('#f1f5f9'), fg: hex('#475569') },
};

export type ColSpec = {
  label: string;
  width: number;                      // before there's anything in it
  align?: 'LEFT' | 'CENTER' | 'RIGHT';
  numberFormat?: { type: 'DATE_TIME' | 'NUMBER' | 'TEXT'; pattern?: string };
  wrap?: boolean;                     // one item per line; the row grows to fit
  chips?: Chip[];
  formula?: boolean;                  // written as =DATE(...) or =HYPERLINK(...)
};

/** How many characters a cell shows: a formula by what it displays. */
export function shownLength(v: unknown): number {
  const s = String(v ?? '');
  if (/^=DATE\(.*\)\+TIME\(/.test(s)) return 21;            // "Nov 13, 2026 12:15 PM"
  if (/^=DATE\(/.test(s)) return 17;                        // "Mon, Jul 12, 2027"
  const link = s.match(/^=HYPERLINK\(".*?","(.*)"\)$/);
  const text = link ? link[1] : s;
  return Math.max(0, ...text.split('\n').map(line => Array.from(line).reduce((n, c) => n + (c.codePointAt(0)! > 0x2000 ? 2 : 1), 0)));
}

/** Column widths in pixels: the header (with room for its filter button) or
 *  the longest line under it, whichever is wider. */
export function fitWidths(headers: string[], rows: unknown[][], max = 560): number[] {
  return headers.map((h, i) => {
    const head = String(h ?? '').length * 8 + 44;
    const body = Math.max(0, ...rows.map(r => shownLength(r[i]))) * 7.5 + 24;
    return Math.round(Math.min(max, Math.max(70, head, body)));
  });
}

/** Everything a tab's look takes, as one batch for the Sheets API. */
export function lookRequests(args: {
  sheetId: number;
  headers: string[];
  specs: Array<ColSpec | undefined>;      // by position; undefined for a column the board added
  widths: number[];
  existing: { bandingIds: number[]; ruleCount: number };
  tabColor: Rgb;
  freezeCols?: number;
}): Record<string, unknown>[] {
  const { sheetId, headers, specs, widths, existing } = args;
  const n = headers.length;
  const req: Record<string, unknown>[] = [];
  for (let i = existing.ruleCount - 1; i >= 0; i--) req.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  for (const id of existing.bandingIds) req.push({ deleteBanding: { bandedRangeId: id } });

  req.push({ updateSheetProperties: {
    properties: { sheetId, gridProperties: { frozenRowCount: 1, frozenColumnCount: args.freezeCols ?? 1 }, tabColorStyle: { rgbColor: args.tabColor } },
    fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount,tabColorStyle',
  } });
  widths.forEach((w, i) => req.push({ updateDimensionProperties: {
    range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: w }, fields: 'pixelSize',
  } }));
  req.push({ updateDimensionProperties: {
    range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 38 }, fields: 'pixelSize',
  } });

  // The header: brand blue, white bold, with a sun-colored line under it.
  req.push({ repeatCell: {
    range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n },
    cell: { userEnteredFormat: {
      backgroundColorStyle: { rgbColor: BRAND_BLUE }, horizontalAlignment: 'CENTER', verticalAlignment: 'MIDDLE',
      textFormat: { bold: true, fontSize: 11, foregroundColorStyle: { rgbColor: WHITE } },
      padding: { top: 8, bottom: 8, left: 10, right: 10 }, wrapStrategy: 'CLIP',
    } },
    fields: 'userEnteredFormat(backgroundColorStyle,horizontalAlignment,verticalAlignment,textFormat,padding,wrapStrategy)',
  } });
  req.push({ updateBorders: {
    range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: n },
    bottom: { style: 'SOLID_THICK', colorStyle: { rgbColor: SUN } },
  } });

  // Each of Poolside's columns. Its number format is set or cleared every
  // time: a column that moved can't keep the old one's (text would turn a
  // date formula into text). A column the board added is left as it is.
  specs.forEach((col, i) => {
    if (!col) return;
    const fmt: Record<string, unknown> = {
      horizontalAlignment: col.align ?? 'LEFT', verticalAlignment: 'TOP',
      textFormat: { fontSize: 10, foregroundColorStyle: { rgbColor: TEXT_DARK }, bold: i === 0 },
      padding: { top: 6, bottom: 6, left: 10, right: 10 },
      wrapStrategy: col.wrap ? 'WRAP' : 'OVERFLOW_CELL',
    };
    if (col.numberFormat) fmt.numberFormat = { type: col.numberFormat.type, ...(col.numberFormat.pattern ? { pattern: col.numberFormat.pattern } : {}) };
    req.push({ repeatCell: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
      cell: { userEnteredFormat: fmt },
      fields: 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat,padding,wrapStrategy,numberFormat)',
    } });
  });

  req.push({ addBanding: { bandedRange: {
    range: { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: n },
    rowProperties: { firstBandColorStyle: { rgbColor: WHITE }, secondBandColorStyle: { rgbColor: BAND_LIGHT } },
  } } });

  let index = 0;
  specs.forEach((col, i) => {
    for (const chip of col?.chips ?? []) {
      const c = CHIP[chip.color];
      req.push({ addConditionalFormatRule: { index: index++, rule: {
        ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 }],
        booleanRule: {
          condition: chip.startsWith !== undefined
            ? { type: 'TEXT_STARTS_WITH', values: [{ userEnteredValue: chip.startsWith }] }
            : { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: chip.contains ?? '' }] },
          format: { backgroundColor: c.bg, textFormat: { foregroundColor: c.fg, bold: true } },
        },
      } } });
    }
  });

  req.push({ setBasicFilter: { filter: { range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: n } } } });
  return req;
}

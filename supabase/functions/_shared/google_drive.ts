// =============================================================================
// google_drive.ts — shared helpers for Drive + Sheets sync
// =============================================================================
// One-way, append-only replication. NO delete operations exist anywhere in
// this file by deliberate design — even a future bug calling deleteFile()
// would fail at compile time because the function does not exist.
//
// Token model: per-tenant refresh_token in google_drive_grants. Access tokens
// are minted per-request (5-min validity from Google) and never persisted.
//
// Scope: drive.file only. App can only see/touch files it created. Files the
// user creates outside Poolside are invisible to us — collision-free, leak-
// proof, and impossible-to-delete-the-wrong-thing.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API        = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD     = 'https://www.googleapis.com/upload/drive/v3/files';
const SHEETS_API       = 'https://sheets.googleapis.com/v4/spreadsheets';
const FOLDER_MIME      = 'application/vnd.google-apps.folder';
const SHEET_MIME       = 'application/vnd.google-apps.spreadsheet';

export type DriveGrant = {
  tenant_id: string;
  refresh_token: string;
  connected_email: string | null;
  root_folder_id: string | null;
  club_folder_id: string | null;
  spreadsheet_id: string | null;
  year_folder_ids: Record<string, string>;
  year_tab_ids: Record<string, number>;
};

// Header row written when a year-tab is first created. Order locked so older
// tabs stay readable even after we add a column to newer ones. Each entry has
// a label + pixel width + alignment + numberFormat so a single source of
// truth governs both content and visual styling.
type ColSpec = {
  label: string;
  width: number;
  align?: 'LEFT' | 'CENTER' | 'RIGHT';
  numberFormat?: { type: 'DATE_TIME' | 'NUMBER' | 'TEXT'; pattern?: string };
};
export const SHEET_COLUMNS: ColSpec[] = [
  { label: 'Submitted',         width: 150, align: 'LEFT',
    numberFormat: { type: 'DATE_TIME', pattern: 'mmm d, yyyy h:mm am/pm' } },
  { label: 'Family',            width: 170, align: 'LEFT' },
  { label: 'Primary Contact',   width: 170, align: 'LEFT' },
  { label: 'Email',             width: 200, align: 'LEFT' },
  { label: 'Phone',             width: 130, align: 'LEFT' },
  { label: 'Tier',              width: 120, align: 'LEFT' },
  { label: 'Adults',            width:  70, align: 'CENTER',
    numberFormat: { type: 'NUMBER', pattern: '0' } },
  { label: 'Kids',              width:  70, align: 'CENTER',
    numberFormat: { type: 'NUMBER', pattern: '0' } },
  { label: 'Policies',          width:  90, align: 'CENTER' },
  { label: 'Address',           width: 200, align: 'LEFT' },
  { label: 'City',              width: 110, align: 'LEFT' },
  { label: 'Zip',               width:  70, align: 'LEFT' },
  { label: 'Emergency Contact', width: 200, align: 'LEFT' },
  { label: 'Payment',           width: 110, align: 'CENTER' },
  { label: 'Application PDF',   width: 110, align: 'CENTER' },
  { label: 'App ID',            width: 100, align: 'LEFT' },
];
export const SHEET_HEADERS = SHEET_COLUMNS.map(c => c.label);

// Brand colors (Poolside) — referenced by formatYearTab when styling a new tab.
const BRAND_BLUE  = { red: 0.039, green: 0.231, blue: 0.361 }; // #0a3b5c
const BRAND_BLUE_L = { red: 0.949, green: 0.965, blue: 0.984 }; // #f2f4fc (banding light)
const WHITE       = { red: 1, green: 1, blue: 1 };

// Refresh access token using the stored refresh_token. Cached only in
// memory of the calling request — never persisted, never shared cross-request.
export async function getAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google token refresh failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Google token response missing access_token');
  return data.access_token as string;
}

// Drive search by name + parent + mimeType. Returns first match's ID, or null.
async function findFile(
  accessToken: string,
  name: string,
  parentId: string | 'root',
  mimeType?: string,
): Promise<string | null> {
  const escName = name.replace(/'/g, "\\'");
  const qParts = [
    `name = '${escName}'`,
    `'${parentId}' in parents`,
    `trashed = false`,
  ];
  if (mimeType) qParts.push(`mimeType = '${mimeType}'`);
  const url = `${DRIVE_API}/files?q=${encodeURIComponent(qParts.join(' and '))}&fields=files(id,name)&pageSize=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive search failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.files?.[0]?.id ?? null;
}

async function createFolder(
  accessToken: string,
  name: string,
  parentId: string | 'root',
): Promise<string> {
  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Drive folder create failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.id as string;
}

// Idempotent: search-then-create. If admin manually deletes the folder in
// Drive between calls, we transparently recreate (folder was outside our
// "current state" but we only re-add forward, never restoring the contents).
export async function ensureFolder(
  accessToken: string,
  name: string,
  parentId: string | 'root',
  cachedId: string | null,
): Promise<string> {
  if (cachedId) {
    // Validate cached ID still exists. One HEAD-style call (cheap).
    try {
      const res = await fetch(`${DRIVE_API}/files/${cachedId}?fields=id,trashed`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.trashed) return cachedId;
      }
    } catch { /* fall through to re-create */ }
  }
  const found = await findFile(accessToken, name, parentId, FOLDER_MIME);
  if (found) return found;
  return await createFolder(accessToken, name, parentId);
}

// Idempotent spreadsheet create. We use Drive API to create the file with
// the Sheet mime-type so the parent folder is set correctly in one call.
export async function ensureSpreadsheet(
  accessToken: string,
  title: string,
  parentFolderId: string,
  cachedId: string | null,
): Promise<string> {
  if (cachedId) {
    try {
      const res = await fetch(`${DRIVE_API}/files/${cachedId}?fields=id,trashed`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        if (!data.trashed) return cachedId;
      }
    } catch { /* fall through */ }
  }
  const found = await findFile(accessToken, title, parentFolderId, SHEET_MIME);
  if (found) return found;
  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: title,
      mimeType: SHEET_MIME,
      parents: [parentFolderId],
    }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Spreadsheet create failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.id as string;
}

// Look up a tab (sheet within spreadsheet) by title. Returns sheetId int
// or null if not found.
export async function findTab(
  accessToken: string,
  spreadsheetId: string,
  title: string,
): Promise<number | null> {
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}?fields=sheets(properties(sheetId,title))`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Spreadsheet fetch failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  const sheet = (data.sheets ?? []).find((s: { properties: { title: string } }) => s.properties?.title === title);
  return sheet ? (sheet.properties.sheetId as number) : null;
}

// Convert a column index (0-based) to A1 letters: 0→A, 25→Z, 26→AA, ...
function colA1(idx: number): string {
  let n = idx, s = '';
  do { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}

// Idempotent year-tab creation. First signup of each calendar year auto-
// creates a new tab next to last year's, with the canonical header row AND
// professional styling: dark-blue header, frozen header row, banded data
// rows, basic filter, sensible column widths, date column number format.
export async function ensureYearTab(
  accessToken: string,
  spreadsheetId: string,
  year: string,
  cachedSheetId: number | null,
): Promise<number> {
  if (cachedSheetId !== null) {
    return cachedSheetId;
  }
  const existing = await findTab(accessToken, spreadsheetId, year);
  if (existing !== null) return existing;

  // 1. Create the tab — frozen first row + brand-blue tab color from creation
  const addRes = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [{
        addSheet: {
          properties: {
            title: year,
            gridProperties: { frozenRowCount: 1 },
            tabColorStyle: { rgbColor: BRAND_BLUE },
          },
        },
      }],
    }),
  });
  if (!addRes.ok) {
    const txt = await addRes.text();
    throw new Error(`Add tab failed: ${addRes.status} ${txt.slice(0, 200)}`);
  }
  const addData = await addRes.json();
  const newId = addData.replies?.[0]?.addSheet?.properties?.sheetId as number;

  // 2. Write the header row text (so styling has labels to render)
  const headerRange = `${year}!A1:${colA1(SHEET_HEADERS.length - 1)}1`;
  const headRes = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(headerRange)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [SHEET_HEADERS] }),
    },
  );
  if (!headRes.ok) {
    const txt = await headRes.text();
    throw new Error(`Header write failed: ${headRes.status} ${txt.slice(0, 200)}`);
  }

  // 3. One batchUpdate that applies ALL the styling at once.
  await formatYearTab(accessToken, spreadsheetId, newId);

  return newId;
}

// Apply professional styling to a tab. Idempotent — safe to call multiple
// times (Sheets API silently no-ops most of these on repeated calls).
export async function formatYearTab(
  accessToken: string,
  spreadsheetId: string,
  sheetId: number,
): Promise<void> {
  const numCols = SHEET_COLUMNS.length;
  const requests: Record<string, unknown>[] = [];

  // — Column widths (one request per width-distinct column for clarity)
  SHEET_COLUMNS.forEach((col, i) => {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 },
        properties: { pixelSize: col.width },
        fields: 'pixelSize',
      },
    });
  });

  // — Row heights: tall header (32), comfy data rows (24)
  requests.push({
    updateDimensionProperties: {
      range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
      properties: { pixelSize: 34 },
      fields: 'pixelSize',
    },
  });
  // (Default row height for body rows; Sheets sets ~21px which is fine)

  // — Header row: brand-blue background, white bold text, centered
  requests.push({
    repeatCell: {
      range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: numCols },
      cell: {
        userEnteredFormat: {
          backgroundColorStyle: { rgbColor: BRAND_BLUE },
          horizontalAlignment: 'CENTER',
          verticalAlignment: 'MIDDLE',
          textFormat: {
            bold: true,
            fontSize: 11,
            foregroundColorStyle: { rgbColor: WHITE },
          },
          padding: { top: 6, bottom: 6, left: 8, right: 8 },
        },
      },
      fields: 'userEnteredFormat(backgroundColorStyle,horizontalAlignment,verticalAlignment,textFormat,padding)',
    },
  });

  // — Per-column data alignment + number format (rows 2…∞)
  SHEET_COLUMNS.forEach((col, i) => {
    const fmt: Record<string, unknown> = {
      horizontalAlignment: col.align ?? 'LEFT',
      verticalAlignment: 'MIDDLE',
      textFormat: { fontSize: 10 },
      padding: { top: 4, bottom: 4, left: 8, right: 8 },
    };
    if (col.numberFormat) {
      fmt.numberFormat = { type: col.numberFormat.type, pattern: col.numberFormat.pattern };
    }
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: i, endColumnIndex: i + 1 },
        cell: { userEnteredFormat: fmt },
        fields: col.numberFormat
          ? 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat,padding,numberFormat)'
          : 'userEnteredFormat(horizontalAlignment,verticalAlignment,textFormat,padding)',
      },
    });
  });

  // — Banded rows (alternating white / very-light-blue) — biggest readability win
  requests.push({
    addBanding: {
      bandedRange: {
        range: {
          sheetId,
          startRowIndex: 0,
          startColumnIndex: 0,
          endColumnIndex: numCols,
        },
        rowProperties: {
          headerColorStyle:     { rgbColor: BRAND_BLUE },
          firstBandColorStyle:  { rgbColor: WHITE },
          secondBandColorStyle: { rgbColor: BRAND_BLUE_L },
        },
      },
    },
  });

  // — Basic filter on the full range so admin gets sortable column headers
  requests.push({
    setBasicFilter: {
      filter: {
        range: { sheetId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: numCols },
      },
    },
  });

  const res = await fetch(`${SHEETS_API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const txt = await res.text();
    // Don't throw — formatting failure is recoverable, sync still works
    console.error(`Tab formatting failed (non-fatal): ${res.status} ${txt.slice(0, 300)}`);
  }
}

// Append a row to a year-tab. Uses USER_ENTERED so dates / numbers parse
// nicely in the spreadsheet (rather than appearing as raw strings).
export async function appendRow(
  accessToken: string,
  spreadsheetId: string,
  tabName: string,
  values: (string | number | null)[],
): Promise<number> {
  const range = `${tabName}!A:A`;
  const res = await fetch(
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values: [values] }),
    },
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Row append failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  // updates.updatedRange returns e.g. "2026!A12:O12" — pull the row index.
  const m = String(data.updates?.updatedRange ?? '').match(/(\d+):/);
  return m ? Number(m[1]) : 0;
}

// Multipart PDF upload to a specific folder. Returns the new file's Drive ID.
export async function uploadPdf(
  accessToken: string,
  parentFolderId: string,
  filename: string,
  pdfBytes: Uint8Array,
): Promise<string> {
  const boundary = 'poolside_drive_boundary_' + Math.random().toString(36).slice(2);
  const metadata = JSON.stringify({
    name: filename,
    parents: [parentFolderId],
    mimeType: 'application/pdf',
  });
  // Build multipart body manually so we can mix JSON metadata + binary PDF.
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    metadata + `\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/pdf\r\n\r\n`,
  );
  const tail = enc.encode(`\r\n--${boundary}--`);
  const body = new Uint8Array(head.length + pdfBytes.length + tail.length);
  body.set(head, 0);
  body.set(pdfBytes, head.length);
  body.set(tail, head.length + pdfBytes.length);

  const res = await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
      'Content-Length': String(body.length),
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PDF upload failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.id as string;
}

// Persist updated cache (folder/sheet IDs) back to google_drive_grants so
// next signup skips the lookup round-trips. Only writes fields that changed.
export async function updateGrantCache(
  sb: SupabaseClient,
  tenantId: string,
  patch: Partial<Pick<DriveGrant, 'root_folder_id' | 'club_folder_id' | 'spreadsheet_id' | 'year_folder_ids' | 'year_tab_ids'>>,
): Promise<void> {
  await sb.from('google_drive_grants').update(patch).eq('tenant_id', tenantId);
}

export async function loadGrant(sb: SupabaseClient, tenantId: string): Promise<DriveGrant | null> {
  const { data } = await sb.from('google_drive_grants')
    .select('tenant_id, refresh_token, connected_email, root_folder_id, club_folder_id, spreadsheet_id, year_folder_ids, year_tab_ids')
    .eq('tenant_id', tenantId).maybeSingle();
  return data as DriveGrant | null;
}

// Build a public-style "open in Drive" link for the PDF or the spreadsheet.
export function driveFileLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}
export function spreadsheetLink(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

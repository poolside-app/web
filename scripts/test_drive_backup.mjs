#!/usr/bin/env node
// The Drive backup, end to end against a pretend Google Drive and Sheets
// (PLAN.md BO). Offline: the real backup code runs, with Google's API, the
// database and pdf-lib replaced by stand-ins kept in memory. Costs nothing.
//
// Usage: node scripts/test_drive_backup.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 300);

const FAKE_PDF = new URL('lib/pdf_lib_fake.mjs', import.meta.url).href;
const remap = { 'https://esm.sh/pdf-lib@1.17.1': FAKE_PDF };
const pdf = await import(FAKE_PDF);
let row = null, sync = null;
try { row = await importTs(new URL('supabase/functions/_shared/drive_row.ts', root), { remap }); } catch (e) { row = null; }
try { sync = await importTs(new URL('supabase/functions/_shared/sync_application.ts', root), { remap }); } catch (e) { console.log('  (sync_application did not load: ' + e.message + ')'); }

// ── The pieces ──────────────────────────────────────────────────────────
console.log('BO2–BO4 · what goes in a row (offline)');
check('drive_row.ts exists', !!row);
if (row) {
  check('BO2: +14085551234 shows as 408-555-1234', row.prettyPhone('+14085551234') === '408-555-1234', row.prettyPhone('+14085551234'));
  check('BO2: (408)-555-1234 and 408.555.1234 too', row.prettyPhone('(408)-555-1234') === '408-555-1234' && row.prettyPhone('408.555.1234') === '408-555-1234');
  check('BO2: a number that isn\'t a US one is left as typed', row.prettyPhone('+44 20 7946 0958') === '+44 20 7946 0958' && row.prettyPhone('') === '');
  check('BO2: the phone inside "Pat Lee — (408)-555-0003" is formatted', row.prettyPhonesIn('Pat Lee — (408)-555-0003') === 'Pat Lee — 408-555-0003', row.prettyPhonesIn('Pat Lee — (408)-555-0003'));
  check('BO3: a value starting with = + - @ can\'t become a formula', row.sheetSafe('=HYPERLINK("x")') === '\'=HYPERLINK("x")' && row.sheetSafe('Smith') === 'Smith' && row.sheetSafe(3) === 3);
  check('BO4: filed under the season it\'s for', row.driveSeason({ membership_year: 2027, created_at: '2026-11-03T20:00:00Z' }, 'America/Los_Angeles') === '2027');
  check('BO4: no season on it: the year it was sent, in pool time', row.driveSeason({ membership_year: null, created_at: '2027-01-01T05:00:00Z' }, 'America/Los_Angeles') === '2026');
  const adults = [{ name: 'Sam Smith', phone: '+14085550001', email: 'sam@example.com' }, { name: 'Jo Smith', phone: '+14085550002', email: 'jo@example.com' }];
  check('BO3: other adults: name, phone, email (not the primary again)', row.adultsCell(adults, 'Sam Smith') === 'Jo Smith · 408-555-0002 · jo@example.com', row.adultsCell(adults, 'Sam Smith'));
  check('BO3: children: name and birthday', row.kidsCell([{ name: 'Tim', dob: '2015-04-02' }, { name: 'Sue' }]) === 'Tim (born 2015-04-02); Sue', row.kidsCell([{ name: 'Tim', dob: '2015-04-02' }, { name: 'Sue' }]));
  check('BO3: a row follows the tab\'s own headers', JSON.stringify(row.rowByHeaders(['Family', 'Phone', 'Gone'], { Phone: '408-555-1234', Family: 'Smith', Extra: 'x' })) === '["Smith","408-555-1234",""]');
}

// ── A pretend Google ────────────────────────────────────────────────────
function fakeGoogle() {
  const g = { files: {}, sheets: {}, formats: [], n: 0, calls: [] };
  const id = p => `${p}${++g.n}`;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const tabOf = (sid, title) => g.sheets[sid]?.tabs.find(t => t.title === title);
  const parseRange = r => { const [title, cells = ''] = decodeURIComponent(r).split('!'); return { title, cells }; };
  const colIdx = letters => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
  // Sheets with USER_ENTERED reads "+14085551234" as a number; "408-555-1234" stays text.
  const entered = v => (typeof v === 'string' && /^[+-]?\d+(\.\d+)?$/.test(v)) ? Number(v) : (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  g.fetch = async (url, init = {}) => {
    const u = new URL(url); const m = (init.method || 'GET').toUpperCase();
    g.calls.push(`${m} ${u.pathname}`);
    if (u.host === 'oauth2.googleapis.com') return json({ access_token: 'at' });
    if (u.pathname.startsWith('/upload/drive/v3/files')) {
      const body = new TextDecoder().decode(init.body);
      const meta = JSON.parse(body.slice(body.indexOf('{'), body.indexOf('}\r\n') + 1));
      const fid = id('pdf'); g.files[fid] = { id: fid, name: meta.name, mimeType: meta.mimeType, parents: meta.parents, trashed: false };
      return json({ id: fid });
    }
    if (u.pathname === '/drive/v3/files' && m === 'GET') {
      const q = u.searchParams.get('q');
      const name = q.match(/name = '((?:[^'\\]|\\.)*)'/)[1].replace(/\\'/g, "'");
      const parent = q.match(/'([^']+)' in parents/)[1];
      const mime = (q.match(/mimeType = '([^']+)'/) || [])[1];
      const hit = Object.values(g.files).find(f => f.name === name && f.parents.includes(parent) && !f.trashed && (!mime || f.mimeType === mime));
      return json({ files: hit ? [{ id: hit.id, name: hit.name }] : [] });
    }
    if (u.pathname === '/drive/v3/files' && m === 'POST') {
      const b = JSON.parse(init.body);
      const fid = id(b.mimeType.endsWith('spreadsheet') ? 'sheet' : 'folder');
      g.files[fid] = { id: fid, name: b.name, mimeType: b.mimeType, parents: b.parents, trashed: false };
      if (b.mimeType.endsWith('spreadsheet')) g.sheets[fid] = { tabs: [{ sheetId: 0, title: 'Sheet1', rows: [] }] };
      return json({ id: fid });
    }
    const fm = u.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
    if (fm) { const f = g.files[fm[1]]; return f ? json({ id: f.id, trashed: f.trashed }) : json({ error: 'notFound' }, 404); }
    const sm = u.pathname.match(/^\/v4\/spreadsheets\/([^/:]+)(.*)$/);
    if (sm) {
      const [, sid, rest] = sm; const sh = g.sheets[sid];
      if (!sh) return json({ error: 'not found' }, 404);
      if (rest === '' && m === 'GET') return json({ sheets: sh.tabs.map(t => ({ properties: { sheetId: t.sheetId, title: t.title } })) });
      if (rest === ':batchUpdate') {
        const reqs = JSON.parse(init.body).requests; const replies = [];
        for (const r of reqs) {
          if (r.addSheet) { const t = { sheetId: 1000 + (++g.n), title: r.addSheet.properties.title, rows: [] }; sh.tabs.push(t); replies.push({ addSheet: { properties: { sheetId: t.sheetId, title: t.title } } }); }
          else if (r.deleteSheet) sh.tabs = sh.tabs.filter(t => t.sheetId !== r.deleteSheet.sheetId);
          else {
            g.formats.push(r); replies.push({});
            // A column formatted as text keeps what's entered as typed (a zip's leading zero).
            const rc = r.repeatCell;
            if (rc?.cell?.userEnteredFormat?.numberFormat?.type === 'TEXT') { const t = sh.tabs.find(x => x.sheetId === rc.range.sheetId); if (t) (t.text ||= new Set()).add(rc.range.startColumnIndex); }
          }
        }
        return json({ replies });
      }
      const vm = rest.match(/^\/values\/([^:?]+)(:append)?$/);
      if (vm) {
        const { title, cells } = parseRange(vm[1]); const tab = tabOf(sid, title);
        if (!tab) return json({ error: { message: `Unable to parse range: ${title}` } }, 400);
        if (vm[2] === ':append') {
          const vals = JSON.parse(init.body).values[0].map((v, i) => tab.text?.has(i) && typeof v === 'string' ? (v.startsWith("'") ? v.slice(1) : v) : entered(v));
          tab.rows.push(vals); const r = tab.rows.length;
          return json({ updates: { updatedRange: `${title}!A${r}:Z${r}` } });
        }
        if (m === 'PUT') {
          const vals = JSON.parse(init.body).values; const a1 = cells.match(/^([A-Z]+)(\d+)/);
          const c0 = colIdx(a1[1]), r0 = Number(a1[2]) - 1;
          vals.forEach((rv, i) => { tab.rows[r0 + i] = tab.rows[r0 + i] || []; rv.forEach((v, j) => { tab.rows[r0 + i][c0 + j] = entered(v); }); });
          return json({});
        }
        // GET: a whole row ("1:1"), a column from row 2 ("T2:T"), one cell ("S3"), or a block.
        let mm;
        if ((mm = cells.match(/^(\d+):(\d+)$/))) return json({ values: tab.rows[Number(mm[1]) - 1] ? [tab.rows[Number(mm[1]) - 1].map(String)] : [] });
        if ((mm = cells.match(/^([A-Z]+)(\d+):([A-Z]+)$/))) { const c = colIdx(mm[1]); return json({ values: [tab.rows.slice(Number(mm[2]) - 1).map(r => String(r?.[c] ?? ''))] }); }
        if ((mm = cells.match(/^([A-Z]+)(\d+)$/))) { const v = tab.rows[Number(mm[2]) - 1]?.[colIdx(mm[1])]; return json(v == null || v === '' ? {} : { values: [[String(v)]] }); }
        return json({ values: tab.rows.length ? tab.rows.map(r => r.map(String)) : undefined });
      }
    }
    return json({ error: `fake google: no route for ${m} ${u.pathname}` }, 501);
  };
  return g;
}

// ── A pretend database ──────────────────────────────────────────────────
function fakeDb(tables) {
  const T = tables;
  function q(table) {
    const st = { filters: [], op: 'select', patch: null, rows: null };
    const match = r => st.filters.every(([k, v]) => r[k] === v);
    const run = () => {
      const all = T[table] = T[table] || [];
      if (st.op === 'insert') { for (const r of st.rows) all.push({ id: `id${all.length + 1}`, ...r }); return { data: st.rows, error: null }; }
      if (st.op === 'update') { for (const r of all.filter(match)) Object.assign(r, st.patch); return { data: null, error: null }; }
      if (st.op === 'upsert') { for (const r of st.rows) { const hit = all.find(x => x.tenant_id === r.tenant_id && (!r.application_id || x.application_id === r.application_id)); hit ? Object.assign(hit, r) : all.push({ id: `id${all.length + 1}`, ...r }); } return { data: null, error: null }; }
      return { data: all.filter(match), error: null };
    };
    const b = {
      select: () => b, order: () => b, limit: () => b, not: () => b, in: () => b,
      eq: (k, v) => { st.filters.push([k, v]); return b; },
      insert: rows => { st.op = 'insert'; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      update: patch => { st.op = 'update'; st.patch = patch; return b; },
      upsert: rows => { st.op = 'upsert'; st.rows = Array.isArray(rows) ? rows : [rows]; return b; },
      maybeSingle: async () => { const r = run(); return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }; },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  return { from: q, tables: T };
}

const TID = 't1';
const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo'.padEnd(120, 'A');
function club(grant = {}) {
  return fakeDb({
    tenants: [{ id: TID, slug: 'bishopestates', display_name: 'Bishop Estates Cabana Club', timezone: 'America/Los_Angeles' }],
    policies: [{ tenant_id: TID, slug: 'waiver', title: 'Waiver', body: 'Swim at your own risk.', sort_order: 1 }],
    settings: [{ tenant_id: TID, value: { membership_tiers: [{ slug: 'family', label: 'Family' }] } }],
    google_drive_grants: [{ tenant_id: TID, refresh_token: 'rt', connected_email: 'board@example.com', root_folder_id: null, club_folder_id: null, spreadsheet_id: null, year_folder_ids: {}, year_tab_ids: {}, ...grant }],
    applications: [], drive_sync_log: [], drive_sync_queue: [],
  });
}
function signup(id, over = {}) {
  return {
    id, tenant_id: TID, created_at: '2026-11-03T20:15:00Z', membership_year: 2027, is_renewal: false,
    family_name: 'Smith', primary_name: 'Sam Smith', primary_email: 'sam@example.com', primary_phone: '+14085550001',
    address: '1 Pool Way', city: 'San Jose', zip: '05123', emergency_contact: 'Pat Lee — (408)-555-0003',
    num_adults: 2, num_kids: 1, tier_slug: 'family', payment_method: 'stripe', payment_status: 'unpaid',
    adults_json: [{ name: 'Sam Smith', phone: '+14085550001', email: 'sam@example.com', signature_url: SIG }, { name: 'Jo Smith', phone: '+14085550002', email: 'jo@example.com', signature_url: SIG }],
    children_json: [{ name: 'Tim', dob: '2015-04-02' }],
    waivers_accepted: { waiver: true }, accepted_at: '2026-11-03T20:15:00Z', signature_primary: null, signature_guardian: SIG,
    ...over,
  };
}
const go = (db, appId) => sync.syncApplicationToDrive(db, { tenantId: TID, applicationId: appId, googleClientId: 'cid', googleClientSecret: 'cs' });
const grantOf = db => db.tables.google_drive_grants[0];
const cellsOf = (g, sid, title) => { const t = g.sheets[sid]?.tabs.find(x => x.title === title); if (!t) return null; const [h, ...rows] = t.rows; return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

if (sync) {
  // ── A new family, signing up in November for the 2027 season ─────────
  console.log('\nA signup, start to finish (pretend Google)');
  const g = fakeGoogle(); globalThis.fetch = g.fetch;
  const db = club(); db.tables.applications.push(signup('app-1', { family_name: '=HYPERLINK("http://x","Smith")' }));
  pdf.resetDrawn();
  const r1 = await go(db, 'app-1');
  check('it backs up', r1.ok && !r1.skipped, short(r1));
  const names = Object.values(g.files).map(f => f.name);
  check('BO4: into "2027 Sign-ups" and the "2027" tab (sent in November 2026)', names.includes('2027 Sign-ups') && !names.includes('2026 Sign-ups') && r1.tab_name === '2027', short({ names, tab: r1.tab_name }));
  const [c] = cellsOf(g, grantOf(db).spreadsheet_id, '2027') || [{}];
  check('BO2: the phone reads 408-555-0001', c.Phone === '408-555-0001', short(c.Phone));
  check('BO2: the emergency contact\'s phone too', c['Emergency Contact'] === 'Pat Lee — 408-555-0003', short(c['Emergency Contact']));
  check('BO3: the other adult, with phone and email', c['Other Adults'] === 'Jo Smith · 408-555-0002 · jo@example.com', short(c['Other Adults']));
  check('BO3: the child, with birthday', c.Children === 'Tim (born 2015-04-02)', short(c.Children));
  check('BO3: name, email, address, city and zip are all there', c['Primary Contact'] === 'Sam Smith' && c.Email === 'sam@example.com' && c.Address === '1 Pool Way' && c.City === 'San Jose' && String(c.Zip) === '05123', short(c));
  check('BO3: marked New', c.Type === 'New', short(c.Type));
  check('BO3: a family name starting with = stays text', c.Family === '=HYPERLINK("http://x","Smith")' && !String(c.Family).startsWith("'"), short(c.Family));
  const textCols = g.formats.filter(f => f.repeatCell?.cell?.userEnteredFormat?.numberFormat?.type === 'TEXT').map(f => f.repeatCell.range.startColumnIndex);
  const hdr = g.sheets[grantOf(db).spreadsheet_id]?.tabs.find(t => t.title === '2027')?.rows[0] || [];
  check('BO2: the Phone and Zip columns are kept as text', textCols.includes(hdr.indexOf('Phone')) && textCols.includes(hdr.indexOf('Zip')), short({ textCols, hdr }));
  const t = pdf.drawn.texts.join('\n');
  check('BO2: the PDF shows 408-555-1234 for the family, each adult and the emergency contact', /408-555-0001/.test(t) && /408-555-0002/.test(t) && /408-555-0003/.test(t) && !/\+1408/.test(t), short(pdf.drawn.texts.filter(x => /408/.test(x))));
  check('the PDF has both adults\' and the guardian\'s signatures', pdf.drawn.images === 3, String(pdf.drawn.images));
  check('the PDF says Membership Application, 2027 season', /Membership Application/.test(t) && /2027 season/.test(t), short(pdf.drawn.texts.slice(0, 6)));

  // ── Verified, found by the header ────────────────────────────────────
  const { markVerifiedInDrive } = sync;
  await markVerifiedInDrive(db, { tenantId: TID, applicationId: 'app-1', method: 'stripe', googleClientId: 'cid', googleClientSecret: 'cs' });
  const [c2] = cellsOf(g, grantOf(db).spreadsheet_id, '2027') || [{}];
  check('a payment marks Verified on the right column', /^Stripe ✓/.test(String(c2.Verified)) && c2['Application PDF'] === c['Application PDF'], short({ v: c2.Verified }));

  // ── BO5: the folder is trashed ───────────────────────────────────────
  console.log('\nBO5 · the board trashes the folder (pretend Google)');
  for (const f of Object.values(g.files)) f.trashed = true;
  db.tables.applications.push(signup('app-2', { family_name: 'Jones', created_at: '2026-11-04T18:00:00Z' }));
  const r2 = await go(db, 'app-2').catch(e => ({ ok: false, error: e.message }));
  check('the next signup still backs up', r2.ok && !r2.skipped, short(r2));
  const fresh = grantOf(db).spreadsheet_id;
  check('into a new folder and sheet, with its own 2027 tab', !g.files[fresh]?.trashed && (cellsOf(g, fresh, '2027') || []).length === 1, short(cellsOf(g, fresh, '2027')));

  // ── An older tab with the old columns ────────────────────────────────
  console.log('\nBO3 · a tab made before the new columns (pretend Google)');
  const g3 = fakeGoogle(); globalThis.fetch = g3.fetch;
  const OLD = ['Submitted', 'Family', 'Primary Contact', 'Email', 'Phone', 'Tier', 'Adults', 'Kids', 'Policies', 'Address', 'City', 'Zip', 'Emergency Contact', 'Paid By', 'Verified', 'Application PDF', 'App ID'];
  g3.files.root = { id: 'root', name: 'Poolside Archive', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], trashed: false };
  g3.files.clubf = { id: 'clubf', name: 'Bishop Estates Cabana Club', mimeType: 'application/vnd.google-apps.folder', parents: ['root'], trashed: false };
  g3.files.old = { id: 'old', name: 'Bishop Estates Cabana Club — Membership Roster', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['clubf'], trashed: false };
  g3.sheets.old = { tabs: [{ sheetId: 77, title: '2027', rows: [OLD] }] };
  const db3 = club({ root_folder_id: 'root', club_folder_id: 'clubf', spreadsheet_id: 'old', year_tab_ids: { 2027: 77 } });
  db3.tables.applications.push(signup('app-3'));
  const r3 = await go(db3, 'app-3').catch(e => ({ ok: false, error: e.message }));
  const [o] = cellsOf(g3, 'old', '2027') || [{}];
  check('the row lines up under the old headers', r3.ok && o.Phone === '408-555-0001' && o['App ID'] === 'app-3' && o.Address === '1 Pool Way' && g3.sheets.old.tabs[0].rows[1].length <= OLD.length, short(o));
  await sync.markVerifiedInDrive(db3, { tenantId: TID, applicationId: 'app-3', method: 'venmo', googleClientId: 'cid', googleClientSecret: 'cs' });
  check('and Verified still lands in its column', /^Manual ✓/.test(String((cellsOf(g3, 'old', '2027') || [{}])[0].Verified)), short(cellsOf(g3, 'old', '2027')));

  // ── BO6: a renewal ───────────────────────────────────────────────────
  console.log('\nBO6 · a renewal (pretend Google)');
  const g4 = fakeGoogle(); globalThis.fetch = g4.fetch;
  const db4 = club();
  db4.tables.applications.push(signup('ren-1', { is_renewal: true, signature_primary: SIG, signature_guardian: null,
    adults_json: [{ name: 'Jo Smith', email: 'jo@example.com', phone: '+14085550002', signature_url: null }, { name: 'Sam Smith', email: 'sam@example.com', phone: '+14085550001', signature_url: null }] }));
  pdf.resetDrawn();
  const r4 = await go(db4, 'ren-1');
  const [rc] = cellsOf(g4, grantOf(db4).spreadsheet_id, '2027') || [{}];
  check('a renewal backs up, marked Renewal', r4.ok && rc.Type === 'Renewal', short({ r4, type: rc.Type }));
  const t4 = pdf.drawn.texts.join('\n');
  check('its PDF is titled Membership Renewal, 2027 season', /Membership Renewal/.test(t4) && /2027 season/.test(t4), short(pdf.drawn.texts.slice(0, 6)));
  const sigAt = pdf.drawn.texts.findIndex(x => /Adult #\d+: Sam Smith/.test(x));
  check('and shows the signature under the person who signed', pdf.drawn.images === 1 && sigAt >= 0 && !/no signature on file/.test(pdf.drawn.texts[sigAt + 1] || ''), short(pdf.drawn.texts.slice(sigAt - 1, sigAt + 3)));
}

// ── Wiring ──────────────────────────────────────────────────────────────
console.log('\nBO1, BO6 · wiring (offline)');
const gds = read('supabase/functions/google_drive_sync/index.ts');
check('BO1: Google always asks which account', /'prompt',\s*'consent select_account'/.test(gds));
check('BO1: and comes back to Settings → Backups & archive', /settings\.html#drive=connected/.test(gds) && !/payments\.html#drive=connected/.test(gds));
const rs = read('supabase/functions/_shared/renewal_sign.ts');
const signed = rs.slice(rs.indexOf('export async function signRenewal'));
check('BO6: signing a renewal sends it to Drive', /backupToDrive\(/.test(signed) && /import\('\.\/sync_application\.ts'\)/.test(signed));
check('BO6: backupToDrive retries later if Drive fails', /export async function backupToDrive/.test(read('supabase/functions/_shared/sync_application.ts')) && /enqueueDriveSync\(/.test(read('supabase/functions/_shared/sync_application.ts').slice(read('supabase/functions/_shared/sync_application.ts').indexOf('export async function backupToDrive'))));
const st = read('club/admin/settings.html');
check('the Settings card says it files by season and includes renewals', /2027 Sign-ups/.test(st) && /renewal/i.test(st.slice(st.indexOf('id="drive-card"'), st.indexOf('id="drive-status"'))));
check('the added-member PDF formats the phone too', /prettyPhone\(/.test(read('supabase/functions/_shared/household_member_pdf.ts')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

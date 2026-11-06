#!/usr/bin/env node
// Upload minutes for a meeting not taken in Poolside (PLAN.md BW, Doug 11/5:
// "if we had a meeting and didn't use the meeting feature, i want to be able
// to say here was a meeting... select a date only... upload the minutes and
// it backs it up and posts it... saying meeting minutes from 1/1/2026...
// then you click the link and it shows the minutes"). His picks: posts right
// away, any board member, PDF, photo or Word, Members or Board only.
// Offline: the server's part against the pretend database, storage and
// Google; the board's page and the members' page rendered in Chrome.
//
// Usage: node scripts/test_minutes_upload.mjs
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importTs } from './lib/importts.mjs';
import { fakeGoogle, fakeDb } from './lib/fake_google.mjs';

const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 300);

globalThis.Deno = { env: { get: () => undefined } };
const FAKE_PDF = new URL('lib/pdf_lib_fake.mjs', import.meta.url).href;
const remap = { 'https://esm.sh/pdf-lib@1.17.1': FAKE_PDF };
let mu = null, dm = null, dp = null;
try { mu = await importTs(new URL('supabase/functions/_shared/minutes_upload.ts', root), { remap }); } catch (e) { console.log('  (minutes_upload did not load: ' + e.message + ')'); }
try { dm = await importTs(new URL('supabase/functions/_shared/drive_minutes.ts', root), { remap }); } catch (e) { console.log('  (drive_minutes did not load: ' + e.message + ')'); }
try { dp = await importTs(new URL('supabase/functions/_shared/drive_parties.ts', root), { remap }); } catch (e) { /* checked in test_minutes_drive */ }

const TID = 't1';
const SUPA = 'https://x.supabase.co';
const KEYS = { googleClientId: 'cid', googleClientSecret: 'cs' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function club() {
  const db = fakeDb({
    tenants: [{ id: TID, slug: 'bishopestates', display_name: 'Bishop Estates Cabana Club', timezone: 'America/Los_Angeles' }],
    google_drive_grants: [{ tenant_id: TID, refresh_token: 'rt', connected_email: 'board@example.com', root_folder_id: null, club_folder_id: null, spreadsheet_id: null, minutes_folder_id: null, year_folder_ids: {}, year_tab_ids: {} }],
    club_documents: [], board_meetings: [], board_minutes_approvals: [], audit_log: [],
    applications: [], drive_sync_log: [], drive_sync_queue: [], party_history: [], policies: [], settings: [],
  });
  const files = {};
  db.files = files;
  db.storage = { from: bucket => ({
    upload: async (path, bytes, opts) => { files[`${bucket}/${path}`] = { bytes, contentType: opts?.contentType }; return { data: { path }, error: null }; },
    download: async path => files[`${bucket}/${path}`] ? { data: new Blob([files[`${bucket}/${path}`].bytes]), error: null } : { data: null, error: { message: 'not found' } },
    remove: async paths => { for (const p of paths) delete files[`${bucket}/${p}`]; return { data: null, error: null }; },
    createSignedUrl: async (path, secs) => ({ data: { signedUrl: `${SUPA}/storage/v1/object/sign/${bucket}/${path}?token=t&exp=${secs}` }, error: null }),
    createSignedUploadUrl: async path => { db.links.push(`${bucket}/${path}`); return { data: { signedUrl: `${SUPA}/storage/v1/object/upload/sign/${bucket}/${path}?token=up`, token: 'up', path }, error: null }; },
    list: async (prefix, opts = {}) => ({ data: Object.entries(files)
      .filter(([k]) => k.startsWith(`${bucket}/${prefix}/`) && k.slice(bucket.length + prefix.length + 2).startsWith(opts.search || ''))
      .map(([k, v]) => ({ name: k.slice(bucket.length + prefix.length + 2), metadata: { size: v.bytes.length, mimetype: v.contentType } })), error: null }),
  }) };
  db.links = [];
  // The board member's phone sending the file to the one-time link.
  db.put = (url, bytes, contentType) => { const m = String(url).match(/\/object\/upload\/sign\/([^?]+)/); if (m) files[decodeURIComponent(m[1])] = { bytes, contentType }; };
  return db;
}
// Both steps, as the page does them (PLAN.md BY4): the link, the file, then save.
async function send(db, body, content, me) {
  const bytes = content == null ? null : Buffer.from(content);
  if (typeof mu.startMinutesUpload !== 'function') return { ok: false, error: 'no startMinutesUpload' };
  const s = await mu.startMinutesUpload(db, TID, { ...body, size: bytes ? bytes.length : 0 });
  if (!s.ok) return s;
  if (bytes) db.put(s.upload_url, bytes, s.content_type);
  return mu.saveUploadedMinutes(db, TID, { ...body, content_type: s.content_type, upload_id: s.id }, me);
}
const SAM = { id: 'adm-sam', name: 'Sam Brooks', isOwner: true };
const MEI = { id: 'adm-chen', name: 'Mei Chen', isOwner: false };
const ANA = { id: 'adm-ruiz', name: 'Ana Ruiz', isOwner: false };

console.log('BW1 · what can be uploaded');
check('_shared/minutes_upload.ts exists', !!mu);
if (mu) {
  const t = (ct, name) => mu.minutesFileType(ct, name);
  check('a PDF', t('application/pdf', 'June.pdf')?.ext === 'pdf');
  check('a Word file (.docx and .doc)', t(DOCX, 'June.docx')?.ext === 'docx' && t('application/msword', 'June.doc')?.ext === 'doc');
  check('a Word file the phone gave no type for, by its name', t('', 'June minutes.docx')?.mime === DOCX && t('application/octet-stream', 'x.PDF')?.ext === 'pdf');
  check('a photo (JPG, PNG)', t('image/jpeg', 'IMG_1.jpg')?.ext === 'jpg' && t('image/png', 'scan.png')?.ext === 'png');
  check('anything else is refused', t('application/zip', 'a.zip') === null && t('', 'run.exe') === null && t('text/html', 'x.html') === null);
  check('BW2: "Meeting minutes from 1/1/2026"', mu.uploadedTitle('2026-01-01') === 'Meeting minutes from 1/1/2026' && mu.uploadedTitle('2026-11-05') === 'Meeting minutes from 11/5/2026', mu.uploadedTitle('2026-01-01'));

  console.log('\nBW3 · saved private, posted at once');
  const db = club();
  const r = await send(db, { meeting_date: '2026-01-01', file_name: 'January minutes.pdf', content_type: 'application/pdf' }, '%PDF-1.4 jan', MEI);
  const row = db.tables.club_documents[0];
  check('it saves', r.ok === true && !!row, short(r));
  check('a minutes row with its date, Members by default, who uploaded it', row?.kind === 'minutes' && row.meeting_date === '2026-01-01' && row.visibility === 'members' && row.uploaded_by === 'adm-chen' && row.uploaded_by_name === 'Mei Chen' && row.file_name === 'January minutes.pdf' && row.content_type === 'application/pdf', short(row));
  const keys = Object.keys(db.files);
  check('the file goes straight to the private club-docs folder, never the public one', keys.length === 1 && keys[0].startsWith(`club-docs/${TID}/minutes-`) && keys[0].endsWith('.pdf') && row?.storage_path === keys[0].slice('club-docs/'.length) && row.url == null, short({ keys, row }));
  check('…as a PDF', db.files[keys[0]]?.contentType === 'application/pdf');
  const r2 = await send(db, { meeting_date: '2026-02-12', visibility: 'private', file_name: 'Closed session.docx', content_type: DOCX }, 'PK word', ANA);
  check('Board only when picked', r2.ok && db.tables.club_documents[1]?.visibility === 'private' && Object.keys(db.files).some(k => k.endsWith('.docx')), short(r2));
  const bad = [
    await send(db, { meeting_date: '', file_name: 'x.pdf', content_type: 'application/pdf' }, 'x', MEI),
    await send(db, { meeting_date: '2026-13-40', file_name: 'x.pdf', content_type: 'application/pdf' }, 'x', MEI),
    await send(db, { meeting_date: '2026-01-01', file_name: 'x.zip', content_type: 'application/zip' }, 'x', MEI),
    await send(db, { meeting_date: '2026-01-01', file_name: 'x.pdf', content_type: 'application/pdf' }, null, MEI),
  ];
  check('no date, a made-up date, a wrong kind of file or no file: refused, nothing saved', bad.every(b => b.ok === false && b.error) && db.tables.club_documents.length === 2, short(bad.map(b => b.error)));
  check('…in plain words', /date/i.test(bad[0].error) && /PDF, a Word file or a photo/.test(bad[2].error), short(bad.map(b => b.error)));
  const big = await send(db, { meeting_date: '2026-01-01', file_name: 'big.pdf', content_type: 'application/pdf' }, 'A'.repeat(36 * 1024 * 1024), MEI);
  check('over 25 MB: refused', big.ok === false && /25 MB/.test(big.error || ''), short(big));
  await send(db, { meeting_date: '2026-03-05', file_name: 'March.jpg', content_type: 'image/jpeg' }, 'jpg', MEI);

  console.log('\nBY4 · straight to storage, not through Poolside\'s server');
  // Doug 11/6: "yes go do that for the minutes uopload". A 25 MB scan sent
  // through the server as text could run out of time or memory there.
  const src = read('supabase/functions/_shared/minutes_upload.ts');
  check('the server never handles the file itself', !/base64|atob\(/.test(src));
  const d4 = club();
  const st = typeof mu.startMinutesUpload === 'function' ? await mu.startMinutesUpload(d4, TID, { meeting_date: '2026-04-02', file_name: 'April.pdf', content_type: 'application/pdf', size: 20 * 1024 * 1024 }) : {};
  check('a 20 MB file gets a one-time link into the private folder', st.ok === true && /^https:\/\/x\.supabase\.co\/storage\/v1\/object\/upload\/sign\/club-docs\/t1\/minutes-[0-9a-f-]{36}\.pdf\?token=/.test(st.upload_url || '') && st.content_type === 'application/pdf', short(st));
  const pre = typeof mu.startMinutesUpload === 'function' ? [
    await mu.startMinutesUpload(d4, TID, { meeting_date: '', file_name: 'x.pdf', content_type: 'application/pdf', size: 10 }),
    await mu.startMinutesUpload(d4, TID, { meeting_date: '2026-04-02', file_name: 'x.zip', content_type: 'application/zip', size: 10 }),
    await mu.startMinutesUpload(d4, TID, { meeting_date: '2026-04-02', file_name: 'x.pdf', content_type: 'application/pdf', size: 26 * 1024 * 1024 }),
  ] : [];
  check('the date, the kind of file and its size are checked before any link', pre.length === 3 && pre.every(p => p.ok === false) && d4.links.length === 1, short(pre.map(p => p.error)));
  const save = async (body, me = MEI) => mu.saveUploadedMinutes(d4, TID, { meeting_date: '2026-04-02', file_name: 'April.pdf', content_type: 'application/pdf', ...body }, me);
  const notYet = await save({ upload_id: st.id });
  check('saving before the file arrived: refused, nothing posted', notYet.ok === false && /didn.t arrive/.test(notYet.error || '') && !d4.tables.club_documents.length, short(notYet));
  d4.put(st.upload_url || '', Buffer.alloc(26 * 1024 * 1024), 'application/pdf');
  const tooBig = await save({ upload_id: st.id });
  check('a file bigger than 25 MB when it lands: refused and removed', tooBig.ok === false && /25 MB/.test(tooBig.error || '') && !Object.keys(d4.files).length, short(tooBig));
  const st2 = typeof mu.startMinutesUpload !== 'function' ? {} : await mu.startMinutesUpload(d4, TID, { meeting_date: '2026-04-02', file_name: 'April.pdf', content_type: 'application/pdf', size: 100 });
  d4.put(st2.upload_url, Buffer.from('<html>'), 'text/html');
  const wrong = await save({ upload_id: st2.id });
  check('a file stored as something other than what was said: refused and removed', wrong.ok === false && !Object.keys(d4.files).length, short(wrong));
  const fake = await save({ upload_id: 'not-an-id' });
  const other = await mu.saveUploadedMinutes(d4, 't2', { meeting_date: '2026-04-02', file_name: 'April.pdf', content_type: 'application/pdf', upload_id: st2.id }, MEI);
  check('a made-up upload, or another club\'s: refused', fake.ok === false && other.ok === false, short({ fake, other }));
  const st3 = typeof mu.startMinutesUpload !== 'function' ? {} : await mu.startMinutesUpload(d4, TID, { meeting_date: '2026-04-02', file_name: 'April.pdf', content_type: 'application/pdf', size: 9 });
  d4.put(st3.upload_url, Buffer.from('%PDF-1.4 '), 'application/pdf');
  const ok1 = await save({ upload_id: st3.id });
  const ok2 = await save({ upload_id: st3.id });
  check('it posts once it\'s there, and a second tap doesn\'t post it twice', ok1.ok === true && ok2.ok === true && d4.tables.club_documents.length === 1 && d4.tables.club_documents[0].id === st3.id, short({ ok1, ok2, n: d4.tables.club_documents.length }));

  console.log('\nBW2 · who sees them');
  const forMembers = await mu.uploadedMinutes(db, TID, { membersOnly: true });
  check('members get Members ones only, newest first', forMembers.map(u => u.meeting_date).join(',') === '2026-03-05,2026-01-01', short(forMembers));
  check('…each with its title and a link that works for an hour', forMembers[1]?.title === 'Meeting minutes from 1/1/2026' && /\/sign\/club-docs\/.*\.pdf\?token=.*exp=3600/.test(forMembers[1]?.url || ''), short(forMembers[1]));
  check('…and nothing about where it\'s stored or who uploaded it', !('storage_path' in (forMembers[0] || {})) && !('uploaded_by' in (forMembers[0] || {})), short(forMembers[0]));
  const forBoard = await mu.uploadedMinutes(db, TID, { me: MEI });
  check('the board gets Board only ones too', forBoard.length === 3 && forBoard.some(u => u.visibility === 'private'), short(forBoard));
  check('BW5: the uploader can delete theirs, not someone else\'s', forBoard.find(u => u.meeting_date === '2026-01-01')?.can_delete === true && forBoard.find(u => u.meeting_date === '2026-02-12')?.can_delete === false, short(forBoard));
  const forPres = await mu.uploadedMinutes(db, TID, { me: SAM });
  check('…the President can delete any', forPres.every(u => u.can_delete === true));

  console.log('\nBW5 · delete');
  const anaDoc = db.tables.club_documents.find(d => d.meeting_date === '2026-02-12');
  const no = await mu.deleteUploadedMinutes(db, TID, anaDoc.id, MEI);
  check('someone else\'s: refused', no.ok === false && no.status === 403 && db.tables.club_documents.some(d => d.id === anaDoc.id), short(no));
  const own = await mu.deleteUploadedMinutes(db, TID, anaDoc.id, ANA);
  check('the uploader\'s own: gone, file too', own.ok === true && !db.tables.club_documents.some(d => d.id === anaDoc.id) && !Object.keys(db.files).some(k => k.endsWith(anaDoc.storage_path)), short(own));
  const janDoc = db.tables.club_documents.find(d => d.meeting_date === '2026-01-01');
  const pres = await mu.deleteUploadedMinutes(db, TID, janDoc.id, SAM);
  check('the President: any', pres.ok === true && !db.tables.club_documents.some(d => d.id === janDoc.id));
  db.tables.club_documents.push({ id: 'by1', tenant_id: TID, kind: 'bylaws', storage_path: 't1/bylaws-by1.pdf' });
  const notMinutes = await mu.deleteUploadedMinutes(db, TID, 'by1', SAM);
  check('only uploaded minutes (never the bylaws)', notMinutes.ok === false && db.tables.club_documents.some(d => d.id === 'by1'), short(notMinutes));
}

console.log('\nBW4 · backed up to Drive');
if (mu && dm) {
  const g = fakeGoogle(); globalThis.fetch = g.fetch;
  const db = club();
  await send(db, { meeting_date: '2026-01-01', file_name: 'January minutes.docx', content_type: DOCX }, 'PK word', MEI);
  await send(db, { meeting_date: '2026-02-12', visibility: 'private', file_name: 'Feb.pdf', content_type: 'application/pdf' }, '%PDF feb', MEI);
  const r = await dm.backupDocs(db, TID, KEYS);
  const pdfs = Object.values(g.files).filter(f => !/folder/.test(f.mimeType));
  const folder = Object.values(g.files).find(f => f.name === 'Board minutes');
  const word = pdfs.find(f => f.name === '2026-01-01 Meeting minutes - uploaded.docx');
  check('into the Board minutes folder, named by date, as uploaded', !!word && word.parents.includes(folder?.id) && pdfs.some(f => f.name === '2026-02-12 Meeting minutes - uploaded.pdf'), short(pdfs.map(f => f.name)));
  check('…a Word file stays a Word file', word?.mimeType === DOCX, word?.mimeType);
  check('…Board only too, and remembered', r.copied === 2 && db.tables.club_documents.every(d => d.drive_file_id), short(r));
  const n = g.calls.filter(c => /upload/.test(c)).length;
  await dm.backupDocs(db, TID, KEYS);
  check('…only once', g.calls.filter(c => /upload/.test(c)).length === n);
  if (dp) {
    const g2 = fakeGoogle(); globalThis.fetch = g2.fetch;
    const db2 = club();
    await send(db2, { meeting_date: '2026-03-05', file_name: 'March.jpg', content_type: 'image/jpeg' }, 'jpg', MEI);
    const rn = await dp.nightlyDrive(db2, TID, KEYS);
    check('the nightly run copies one that was missed', Object.values(g2.files).some(f => f.name === '2026-03-05 Meeting minutes - uploaded.jpg' && f.mimeType === 'image/jpeg'), short(rn));
  }
}

// ── The server's wiring ─────────────────────────────────────────────────
console.log('\nWiring');
const bm = read('supabase/functions/board_meetings/index.ts');
const part = (src, start, end) => { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i + start.length); return src.slice(i, j < 0 ? undefined : j); };
check('board_meetings uses minutes_upload.ts', /from '\.\.\/_shared\/minutes_upload\.ts'/.test(bm));
const up = part(bm, "action === 'upload_minutes'", "if (action ===");
check('BY4: an upload_minutes_start action for the link, any board member', /startMinutesUpload\(/.test(part(bm, "action === 'upload_minutes_start'", "if (action ===")) && !/isOwner/.test(part(bm, "action === 'upload_minutes_start'", "if (action ===")));
check('BW1: an upload_minutes action, any board member, backed up after', /saveUploadedMinutes\(/.test(up) && /docsLater\(/.test(up) && !/isOwner/.test(up), up.slice(0, 200));
check('BW5: a delete_upload action', /deleteUploadedMinutes\(/.test(part(bm, "action === 'delete_upload'", "if (action ===")));
check('BW2: the board\'s list has them', /uploadedMinutes\(/.test(part(bm, "action === 'list'", "action === 'get'")));
const gov = part(bm, "action === 'governance'", '// ── Admin-only actions');
check('BW2: the members\' page gets Members ones only', /uploadedMinutes\([^)]*membersOnly: true/.test(gov), gov.slice(-600));
const migDir = new URL('supabase/migrations/', root);
const mig = readdirSync(migDir).filter(f => /minutes_upload/.test(f)).map(f => readFileSync(new URL(f, migDir), 'utf8')).join('\n');
check('one migration: minutes as a kind, with a date, who sees it and the file type', /'minutes'/.test(mig) && /meeting_date/.test(mig) && /visibility/.test(mig) && /content_type/.test(mig), mig ? '' : 'no *_minutes_upload.sql');
check('the help article says how', /Upload minutes/.test(read('club/admin/help/articles/board-minutes.md')));
check('the offline CI runs this test', /\btest_minutes_upload\b/.test(read('.github/workflows/offline-tests.yml')));

// ── The pages ───────────────────────────────────────────────────────────
console.log('\nThe pages (Chrome)');
const { launch, attach, BOARD, FAMILY } = await import('./demo_video/harness.mjs');
const { respond } = await import('./demo_video/data.mjs');
const dir = mkdtempSync(join(tmpdir(), 'minutes-upload-'));
const pdfPath = join(dir, 'January minutes.pdf');
writeFileSync(pdfPath, '%PDF-1.4 January');
const UPLOADS = [
  { id: 'u1', title: 'Meeting minutes from 1/1/2026', meeting_date: '2026-01-01', visibility: 'members', url: 'https://x.supabase.co/storage/v1/object/sign/club-docs/t1/minutes-u1.pdf?token=a', file_name: 'January minutes.pdf', content_type: 'application/pdf', uploaded_by_name: 'Mei Chen', uploaded_at: '2026-11-05T18:00:00Z', can_delete: true },
  { id: 'u2', title: 'Meeting minutes from 2/12/2026', meeting_date: '2026-02-12', visibility: 'private', url: 'https://x.supabase.co/storage/v1/object/sign/club-docs/t1/minutes-u2.docx?token=b', file_name: 'Closed.docx', content_type: DOCX, uploaded_by_name: 'Ana Ruiz', uploaded_at: '2026-11-05T18:00:00Z', can_delete: false },
];
const MEETINGS = [{ id: 'm1', title: 'March board meeting', meeting_date: '2026-03-12', status: 'completed', minutes_status: 'approved', visibility: 'members', attendees_json: [], votes_json: [], follow_ups_json: [], approval: {} },
  { id: 'm0', title: 'December board meeting', meeting_date: '2025-12-04', status: 'completed', minutes_status: 'approved', visibility: 'members', attendees_json: [], votes_json: [], follow_ups_json: [], approval: {} }];
const sent = [];
const LINK = 'https://x.supabase.co/storage/v1/object/upload/sign/club-docs/t1/minutes-0d6f1c2e-0000-4000-8000-000000000009.pdf?token=up';
const answer = (f, body, ctx) => {
  if (f === 'board_meetings') {
    if (body.action === 'list') return { ok: true, meetings: MEETINGS, uploads: UPLOADS };
    if (body.action === 'upload_minutes_start') { sent.push(body); return { ok: true, id: '0d6f1c2e-0000-4000-8000-000000000009', upload_url: LINK, content_type: 'application/pdf' }; }
    if (body.action === 'upload_minutes') { sent.push(body); return { ok: true, upload: { ...UPLOADS[0], id: 'u9' } }; }
    if (body.action === 'delete_upload') { sent.push(body); return { ok: true }; }
    if (body.action === 'governance') return { ok: true, meetings: MEETINGS.map(m => ({ ...m, notes_md: 'Notes.' })), uploads: [UPLOADS[0]], bylaws: { current: null, earlier: [] }, board: [] };
  }
  return respond(f, body, ctx);
};
const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let confirms = 0;
  page.on('dialog', d => { confirms++; d.accept(); });
  // What the phone sends to storage, caught in the page before it leaves.
  await page.evaluateOnNewDocument(() => {
    const real = window.fetch;
    window.__puts = [];
    window.fetch = async (url, init = {}) => {
      if ((init.method || 'GET') === 'PUT' && /\/object\/upload\/sign\//.test(String(url))) {
        const body = init.body instanceof Blob ? await init.body.text() : String(init.body ?? '');
        window.__puts.push({ url: String(url), type: (init.headers || {})['content-type'] || '', body });
        return new Response('{"Key":"ok"}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return real(url, init);
    };
  });
  await attach(page, { answer });
  await page.goto(BOARD + '/club/admin/board-meetings.html', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 600));
  const btn = await page.evaluate(() => [...document.querySelectorAll('button')].some(b => /📎 Upload minutes/.test(b.textContent)));
  check('BW1: "📎 Upload minutes" next to Start a meeting', btn);
  const list = await page.evaluate(() => [...document.querySelectorAll('#list-host .list-row')].map(r => ({ text: r.innerText.replace(/\s+/g, ' '), href: r.querySelector('a[href]')?.getAttribute('href') || r.getAttribute('href') || '' })));
  check('BW2: the board\'s list has them in date order with the typed ones', list.map(r => (r.text.match(/Meeting minutes from [\d/]+|March board meeting|December board meeting/) || [''])[0]).join(' | ') === 'March board meeting | Meeting minutes from 2/12/2026 | Meeting minutes from 1/1/2026 | December board meeting', short(list.map(r => r.text)));
  const jan = list.find(r => /1\/1\/2026/.test(r.text));
  check('…tapping one opens the file', /minutes-u1\.pdf/.test(jan?.href || ''), short(jan));
  check('…marked Uploaded, and Members or Board only', /Uploaded/i.test(jan?.text || '') && /Members/i.test(jan?.text || '') && /Board only/i.test(list.find(r => /2\/12\/2026/.test(r.text))?.text || ''), short(list));
  const dels = await page.evaluate(() => [...document.querySelectorAll('#list-host [data-delete-upload]')].map(b => b.dataset.deleteUpload));
  check('BW5: a delete button only where they may delete', JSON.stringify(dels) === '["u1"]', short(dels));

  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /📎 Upload minutes/.test(b.textContent))?.click());
  await new Promise(r => setTimeout(r, 300));
  const form = await page.evaluate(() => {
    const f = document.getElementById('upload-form');
    if (!f || f.offsetParent === null) return null;
    return {
      date: !!f.querySelector('input[type="date"]'),
      accept: f.querySelector('input[type="file"]')?.getAttribute('accept') || '',
      vis: [...f.querySelectorAll('input[name="up-vis"]')].map(i => ({ v: i.value, on: i.checked })),
      text: f.innerText,
    };
  });
  check('BW1: a form: the date, the file, and who sees it', form && form.date && /application\/pdf/.test(form.accept) && /\.docx/.test(form.accept) && /image\//.test(form.accept), short(form));
  check('…Members picked unless you choose Board only', JSON.stringify(form?.vis) === '[{"v":"members","on":true},{"v":"private","on":false}]', short(form?.vis));
  await page.evaluate(() => [...document.querySelectorAll('#upload-form button')].find(b => /^Upload$/.test(b.textContent.trim()))?.click());
  await new Promise(r => setTimeout(r, 300));
  const msg1 = await page.evaluate(() => document.getElementById('upload-msg')?.textContent || '');
  check('no date or file: it says so, nothing sent', /date/i.test(msg1) && !sent.length, msg1);
  await page.evaluate(() => { const i = document.querySelector('#upload-form input[type="date"]'); i.value = '2026-01-01'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  const fileInput = await page.$('#upload-form input[type="file"]');
  await fileInput.uploadFile(pdfPath);
  const preview = await page.evaluate(() => document.getElementById('upload-form').innerText);
  check('it shows what members will see', /Meeting minutes from 1\/1\/2026/.test(preview), preview.slice(0, 300));
  await page.evaluate(() => [...document.querySelectorAll('#upload-form button')].find(b => /^Upload$/.test(b.textContent.trim()))?.click());
  for (let i = 0; i < 30 && sent.length < 2; i++) await new Promise(r => setTimeout(r, 100));
  const [s0 = {}, s = {}] = sent;
  const puts = await page.evaluate(() => window.__puts || []);
  check('BY4: it asks for the link with the date, the file\'s name, type and size', s0.action === 'upload_minutes_start' && s0.meeting_date === '2026-01-01' && s0.file_name === 'January minutes.pdf' && s0.content_type === 'application/pdf' && s0.size === 16 && !('base64' in s0), short(s0));
  check('BY4: the file goes straight to that link, as itself', puts.length === 1 && puts[0].url === LINK && puts[0].type === 'application/pdf' && puts[0].body === '%PDF-1.4 January', short(puts));
  check('Upload then sends the date, the file and who sees it', s.action === 'upload_minutes' && s.upload_id === '0d6f1c2e-0000-4000-8000-000000000009' && s.meeting_date === '2026-01-01' && s.visibility === 'members' && s.file_name === 'January minutes.pdf' && s.content_type === 'application/pdf' && !('base64' in s), short(s));
  await new Promise(r => setTimeout(r, 400));
  const after = await page.evaluate(() => ({ open: document.getElementById('upload-form')?.offsetParent !== null, msg: document.getElementById('upload-msg')?.textContent || '' }));
  check('…then the form closes and the list refreshes', after.open === false, short(after));
  sent.length = 0;
  await page.evaluate(() => document.querySelector('#list-host [data-delete-upload="u1"]')?.click());
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise(r => setTimeout(r, 100));
  check('Delete asks first, then deletes it', confirms >= 1 && sent[0]?.action === 'delete_upload' && sent[0]?.id === 'u1', short(sent));
  check('no page errors on the board page', !errors.length, errors.join(' | '));

  const mp = await browser.newPage();
  await mp.setViewport({ width: 390, height: 844 });
  const merr = [];
  mp.on('pageerror', e => merr.push(e.message));
  await attach(mp, { answer });
  await mp.goto(FAMILY + '/governance.html', { waitUntil: 'networkidle0', timeout: 45000 });
  await new Promise(r => setTimeout(r, 600));
  const gv = await mp.evaluate(() => ({
    order: [...document.querySelectorAll('#meetings-host > *')].map(el => (el.innerText.match(/Meeting minutes from [\d/]+|March board meeting|December board meeting/) || [''])[0]),
    link: [...document.querySelectorAll('#meetings-host a[href]')].find(a => /Meeting minutes from 1\/1\/2026/.test(a.innerText))?.getAttribute('href') || '',
    target: [...document.querySelectorAll('#meetings-host a[href]')].find(a => /Meeting minutes from 1\/1\/2026/.test(a.innerText))?.getAttribute('target') || '',
  }));
  check('BW2: members see "Meeting minutes from 1/1/2026" in date order', gv.order.join(' | ') === 'March board meeting | Meeting minutes from 1/1/2026 | December board meeting', short(gv.order));
  check('…and tapping it opens the minutes', /minutes-u1\.pdf/.test(gv.link) && gv.target === '_blank', short(gv));
  check('no page errors on the members\' page', !merr.length, merr.join(' | '));
} finally { await browser.close(); }

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

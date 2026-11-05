#!/usr/bin/env node
// Board minutes and bylaws backed up to Google Drive (PLAN.md BV, Doug 11/5:
// "we should probably backup the meeting minutes as well in the google
// drive"). His picks: drafts too, Board-only minutes too, PDF, the bylaws
// too, one draft file kept up to date. Offline: the real backup code runs
// against a pretend Google Drive, database and pdf-lib. Costs nothing.
//
// Usage: node scripts/test_minutes_drive.mjs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
const pdf = await import(FAKE_PDF);
let mp = null, dm = null, dp = null;
try { mp = await importTs(new URL('supabase/functions/_shared/minutes_pdf.ts', root), { remap }); } catch (e) { console.log('  (minutes_pdf did not load: ' + e.message + ')'); }
try { dm = await importTs(new URL('supabase/functions/_shared/drive_minutes.ts', root), { remap }); } catch (e) { console.log('  (drive_minutes did not load: ' + e.message + ')'); }
try { dp = await importTs(new URL('supabase/functions/_shared/drive_parties.ts', root), { remap }); } catch (e) { console.log('  (drive_parties did not load: ' + e.message + ')'); }

const TID = 't1';
const TZ = 'America/Los_Angeles';
const KEYS = { googleClientId: 'cid', googleClientSecret: 'cs' };
const meeting = (over = {}) => ({
  id: 'mtg1', tenant_id: TID, title: 'November board meeting', meeting_date: '2026-11-05', location: 'Clubhouse',
  status: 'completed', minutes_status: 'draft', visibility: 'members', approval_round: 0, posted_count: 0, posted_json: null, posted_at: null,
  started_at: '2026-11-06T03:02:00Z', ended_at: '2026-11-06T04:15:00Z', created_by: 'adm-sam',
  notes_md: 'Opened at 7:02.\nPool heater quote reviewed.',
  attendees_json: [
    { admin_user_id: 'adm-sam', name: 'Sam Brooks', role: 'President', source: 'admin' },
    { admin_user_id: 'adm-chen', name: 'Mei Chen', role: 'Secretary', source: 'admin' },
    { admin_user_id: null, name: 'Lee Park', role: 'New board member', source: 'manual' },
  ],
  votes_json: [{ id: 'v1', motion: 'Approve the heater quote', proposed_by: 'Mei Chen', seconded_by: 'Lee Park', yes: 3, no: 0, abstain: 0, outcome: 'passed', notes: null }],
  follow_ups_json: [{ id: 'f1', description: 'Call the heater company', assigned_to: 'Sam Brooks', due_date: '2026-11-12', status: 'open' }],
  drive_draft_file_id: null, drive_draft_hash: null, drive_posted_count: 0,
  ...over,
});
function club(over = {}) {
  const db = fakeDb({
    tenants: [{ id: TID, slug: 'bishopestates', display_name: 'Bishop Estates Cabana Club', timezone: TZ }],
    google_drive_grants: [{ tenant_id: TID, refresh_token: 'rt', connected_email: 'board@example.com', root_folder_id: null, club_folder_id: null, spreadsheet_id: null, minutes_folder_id: null, year_folder_ids: {}, year_tab_ids: {} }],
    board_meetings: [meeting(over)], board_minutes_approvals: [], club_documents: [],
    applications: [], drive_sync_log: [], drive_sync_queue: [], party_history: [], audit_log: [], policies: [], settings: [],
  });
  db.storage = { from: bucket => ({ download: async path => bucket === 'club-docs' && path ? { data: new Blob(['%PDF-1.4 bylaws']), error: null } : { data: null, error: { message: 'not found' } } }) };
  return db;
}
const mtg = db => db.tables.board_meetings[0];
const files = g => Object.values(g.files);
const pdfs = g => files(g).filter(f => f.mimeType === 'application/pdf' && !f.trashed);
const uploads = g => g.calls.filter(c => c.startsWith('POST /upload/') || c.startsWith('PATCH /upload/')).length;
const go = db => dm.backupMinutes(db, TID, 'mtg1', KEYS);

// ── The PDF ─────────────────────────────────────────────────────────────
console.log('BV2 · the minutes as a PDF');
check('_shared/minutes_pdf.ts exists', !!mp);
if (mp) {
  pdf.resetDrawn();
  await mp.renderMinutesPdf({ club: 'Bishop Estates Cabana Club', tz: TZ, state: 'draft', ...meeting() });
  const t = pdf.drawn.texts.join('\n');
  check('the club, the title and the date', /Bishop Estates Cabana Club/.test(t) && /November board meeting/.test(t) && /Thursday, November 5, 2026/.test(t), short(pdf.drawn.texts.slice(0, 6)));
  check('the place and the times, in pool time', /Clubhouse/.test(t) && /7:02 PM/.test(t) && /8:15 PM/.test(t), short(pdf.drawn.texts.slice(0, 8)));
  check('a draft says so at the top', /Draft, not approved yet/.test(t), short(pdf.drawn.texts.slice(0, 8)));
  check('attendance, including people added by hand', /Sam Brooks/.test(t) && /Mei Chen/.test(t) && /Lee Park/.test(t));
  check('the notes, line by line', pdf.drawn.texts.includes('Opened at 7:02.') && pdf.drawn.texts.includes('Pool heater quote reviewed.'), short(pdf.drawn.texts));
  check('each motion with who made it, the second, the count and the outcome',
    /Approve the heater quote/.test(t) && /Proposed by Mei Chen · Seconded by Lee Park · 3-0 · Passed/.test(t), short(pdf.drawn.texts.filter(x => /Proposed/.test(x))));
  check('follow-ups with who and when', /Call the heater company/.test(t) && /Sam Brooks/.test(t) && /Nov 12/.test(t));
  pdf.resetDrawn();
  await mp.renderMinutesPdf({ club: 'Bishop Estates Cabana Club', tz: TZ, state: 'approved', ...meeting({ visibility: 'private' }), approved_at: '2026-11-12T18:00:00Z',
    approvers: [{ name: 'Sam Brooks' }, { name: 'Mei Chen', on_behalf_by: 'Sam Brooks' }] });
  const a = pdf.drawn.texts.join('\n');
  check('an approved copy says when and who approved it', /Approved November 12, 2026/.test(a) && /Sam Brooks/.test(a) && /Mei Chen \(approved for them by Sam Brooks\)/.test(a) && !/Draft, not approved yet/.test(a), short(pdf.drawn.texts.slice(0, 10)));
  check('a Board-only copy says it\'s board only', /Board only/.test(a));
  pdf.resetDrawn();
  await mp.renderMinutesPdf({ club: 'Bishop Estates Cabana Club', tz: TZ, state: 'approved', amended: true, ...meeting(), approved_at: '2026-11-20T18:00:00Z', approvers: [] });
  check('an approved amendment says it\'s amended', /Amended minutes, approved November 20, 2026/.test(pdf.drawn.texts.join('\n')), short(pdf.drawn.texts.slice(0, 8)));
  check('names: the date and title, then draft / approved / amended', mp.minutesFileName(meeting(), 'draft') === '2026-11-05 November board meeting - draft.pdf'
    && mp.minutesFileName(meeting(), 'approved', { approvedDay: '2026-11-12' }) === '2026-11-05 November board meeting - approved 2026-11-12.pdf'
    && mp.minutesFileName(meeting(), 'approved', { approvedDay: '2026-11-20', amended: true }) === '2026-11-05 November board meeting - amended, approved 2026-11-20.pdf'
    && mp.minutesFileName(meeting({ title: 'Budget / dues' }), 'draft') === '2026-11-05 Budget - dues - draft.pdf',
    short([mp.minutesFileName(meeting(), 'draft'), mp.minutesFileName(meeting({ title: 'Budget / dues' }), 'draft')]));
}

// ── The backup ──────────────────────────────────────────────────────────
console.log('\nBV1, BV3 · the folder and one draft file');
check('_shared/drive_minutes.ts exists', !!dm);
if (dm) {
  {
    const g = fakeGoogle(); globalThis.fetch = g.fetch;
    const off = club(); off.tables.google_drive_grants = [];
    const r = await dm.backupMinutes(off, TID, 'mtg1', KEYS);
    check('Drive not connected: nothing happens', r.skipped === true && g.calls.length === 0, short(r));
    const open = club({ status: 'in_progress' });
    const r2 = await dm.backupMinutes(open, TID, 'mtg1', KEYS);
    check('a meeting still going isn\'t copied', r2.skipped === true && g.calls.length === 0, short(r2));
  }

  const g = fakeGoogle(); globalThis.fetch = g.fetch;
  const db = club();
  const r1 = await go(db);
  const folder = files(g).find(f => f.name === 'Board minutes');
  const clubF = files(g).find(f => f.name === 'Bishop Estates Cabana Club');
  const rootF = files(g).find(f => f.name === 'Poolside Archive');
  check('BV1: a "Board minutes" folder inside the club\'s folder in Poolside Archive', folder && clubF && rootF && folder.parents.includes(clubF.id) && clubF.parents.includes(rootF.id), short(files(g)));
  check('BV1: the folders are remembered', db.tables.google_drive_grants[0].minutes_folder_id === folder?.id && db.tables.google_drive_grants[0].club_folder_id === clubF?.id);
  check('BV3: closing saves the draft', r1.ok && pdfs(g).length === 1 && pdfs(g)[0].name === '2026-11-05 November board meeting - draft.pdf' && pdfs(g)[0].parents.includes(folder?.id), short({ r1, f: pdfs(g) }));
  check('BV3: the meeting remembers its draft file', mtg(db).drive_draft_file_id === pdfs(g)[0]?.id && !!mtg(db).drive_draft_hash, short(mtg(db)));
  const n1 = uploads(g);
  await go(db);
  check('BV3: nothing changed, nothing written', uploads(g) === n1, short(g.calls.slice(-6)));

  mtg(db).notes_md += '\nAdjourned at 8:15.';
  mtg(db).title = 'November meeting';
  const firstId = mtg(db).drive_draft_file_id;
  await go(db);
  check('BV3: a changed draft rewrites the same file (no second draft)', pdfs(g).length === 1 && pdfs(g)[0].id === firstId && pdfs(g)[0].writes === 2, short(pdfs(g)));
  check('BV3: …renamed to the new title', pdfs(g)[0].name === '2026-11-05 November meeting - draft.pdf', pdfs(g)[0]?.name);

  g.files[firstId].trashed = true;
  mtg(db).notes_md += '\nOne more line.';
  await go(db);
  check('BV3: a draft file trashed in Drive is saved again as a new file', pdfs(g).length === 1 && pdfs(g)[0].id !== firstId && mtg(db).drive_draft_file_id === pdfs(g)[0].id, short(pdfs(g)));

  console.log('\nBV4 · approved files');
  db.tables.board_minutes_approvals.push(
    { meeting_id: 'mtg1', round: 1, admin_id: 'adm-sam', name: 'Sam Brooks', status: 'approved', on_behalf: false, decided_by_name: 'Sam Brooks' },
    { meeting_id: 'mtg1', round: 1, admin_id: 'adm-chen', name: 'Mei Chen', status: 'approved', on_behalf: true, decided_by_name: 'Sam Brooks' },
  );
  const { snapshot } = await importTs(new URL('supabase/functions/_shared/minutes_approval.ts', root));
  Object.assign(mtg(db), { minutes_status: 'approved', approval_round: 1, posted_count: 1, posted_at: '2026-11-12T18:00:00Z', posted_json: snapshot(mtg(db)) });
  pdf.resetDrawn();
  await go(db);
  const approved = pdfs(g).find(f => /approved 2026-11-12/.test(f.name));
  check('the last approval adds an approved file; the draft stays', approved?.name === '2026-11-05 November meeting - approved 2026-11-12.pdf' && pdfs(g).length === 2, short(pdfs(g).map(f => f.name)));
  check('…with who approved it', pdf.drawn.texts.some(t => /Mei Chen \(approved for them by Sam Brooks\)/.test(t)), short(pdf.drawn.texts.slice(0, 10)));
  check('…and the meeting remembers it was copied', mtg(db).drive_posted_count === 1);
  const n2 = uploads(g);
  await go(db);
  check('run again: no second approved file', uploads(g) === n2 && pdfs(g).length === 2, short(pdfs(g).map(f => f.name)));

  // An amendment: a draft again (the draft file is rewritten), then approved.
  Object.assign(mtg(db), { minutes_status: 'draft', notes_md: mtg(db).notes_md + '\nCorrected the heater price.' });
  await go(db);
  check('an amendment rewrites the draft file', pdfs(g).length === 2 && pdfs(g).find(f => /- draft\.pdf$/.test(f.name))?.writes === 2, short(pdfs(g)));
  db.tables.board_minutes_approvals.push({ meeting_id: 'mtg1', round: 2, admin_id: 'adm-sam', name: 'Sam Brooks', status: 'approved', on_behalf: false, decided_by_name: 'Sam Brooks' });
  Object.assign(mtg(db), { minutes_status: 'approved', approval_round: 2, posted_count: 2, posted_at: '2026-11-20T18:00:00Z', posted_json: snapshot(mtg(db)) });
  pdf.resetDrawn();
  await go(db);
  check('an approved amendment adds its own file; earlier files stay', pdfs(g).some(f => f.name === '2026-11-05 November meeting - amended, approved 2026-11-20.pdf') && pdfs(g).length === 3, short(pdfs(g).map(f => f.name)));
  check('…from the copy members see, approvals of that round only', !pdf.drawn.texts.some(t => /Mei Chen \(approved for/.test(t)) && pdf.drawn.texts.some(t => /Corrected the heater price/.test(t)), short(pdf.drawn.texts.slice(0, 12)));

  {
    const g2 = fakeGoogle(); globalThis.fetch = g2.fetch;
    const priv = club({ visibility: 'private' });
    await dm.backupMinutes(priv, TID, 'mtg1', KEYS);
    check('Board-only minutes are copied too', pdfs(g2).length === 1, short(pdfs(g2)));
    const f = files(g2).find(x => x.name === 'Board minutes');
    f.trashed = true;
    mtg(priv).notes_md += '\nmore';
    await dm.backupMinutes(priv, TID, 'mtg1', KEYS);
    const again = files(g2).filter(x => x.name === 'Board minutes' && !x.trashed);
    check('a trashed Board minutes folder is made again', again.length === 1 && again[0].id !== f.id && priv.tables.google_drive_grants[0].minutes_folder_id === again[0].id, short(files(g2)));
  }

  console.log('\nBV5 · the bylaws');
  {
    const g3 = fakeGoogle(); globalThis.fetch = g3.fetch;
    const db3 = club();
    db3.tables.club_documents.push({ id: 'doc1', tenant_id: TID, kind: 'bylaws', storage_path: 't1/bylaws-doc1.pdf', file_name: 'Bylaws.pdf', uploaded_at: '2026-11-05T20:00:00Z', drive_file_id: null });
    const r = await dm.backupBylaws(db3, TID, KEYS);
    const b = pdfs(g3).find(f => /^Bylaws/.test(f.name));
    const folder3 = files(g3).find(f => f.name === 'Board minutes');
    check('each new version is copied to the Board minutes folder', b?.name === 'Bylaws - posted 2026-11-05.pdf' && b.parents.includes(folder3?.id) && r.copied === 1, short({ r, f: pdfs(g3) }));
    check('…and remembered', db3.tables.club_documents[0].drive_file_id === b?.id);
    const n = uploads(g3);
    await dm.backupBylaws(db3, TID, KEYS);
    check('…only once', uploads(g3) === n);
  }

  console.log('\nBV6 · the nightly run catches up');
  if (dp) {
    const g4 = fakeGoogle(); globalThis.fetch = g4.fetch;
    const db4 = club();
    db4.tables.board_meetings.push(meeting({ id: 'mtg2', title: 'October meeting', meeting_date: '2026-10-08', minutes_status: 'approved', approval_round: 1, posted_count: 1, posted_at: '2026-10-15T18:00:00Z', posted_json: snapshot(meeting({ title: 'October meeting', meeting_date: '2026-10-08' })) }));
    db4.tables.board_meetings.push(meeting({ id: 'mtg3', status: 'in_progress', title: 'Still going' }));
    db4.tables.club_documents.push({ id: 'doc1', tenant_id: TID, kind: 'bylaws', storage_path: 't1/bylaws-doc1.pdf', file_name: 'Bylaws.pdf', uploaded_at: '2026-11-05T20:00:00Z', drive_file_id: null });
    const r = await dp.nightlyDrive(db4, TID, KEYS);
    const names = pdfs(g4).map(f => f.name).sort();
    check('a club that connects Drive later gets every closed meeting and the bylaws', JSON.stringify(names) === JSON.stringify(['2026-10-08 October meeting - approved 2026-10-15.pdf', '2026-11-05 November board meeting - draft.pdf', 'Bylaws - posted 2026-11-05.pdf']), short(names));
    check('…an approved meeting gets only its approved file', !names.some(n => /October meeting - draft/.test(n)));
    check('…and the nightly result counts them', r.minutes === 2 && r.bylaws === 1, short(r));
    const n = uploads(g4);
    await dp.nightlyDrive(db4, TID, KEYS);
    check('the next night copies nothing again', uploads(g4) === n, short(g4.calls.filter(c => /upload/.test(c))));
    // A Drive failure on minutes doesn't stop the rest of the run.
    const g5 = fakeGoogle();
    globalThis.fetch = async (url, init) => (String(url).includes('/upload/') ? new Response('{"error":"boom"}', { status: 500 }) : g5.fetch(url, init));
    const db5 = club();
    const r5 = await dp.nightlyDrive(db5, TID, KEYS);
    check('a minutes copy that fails is reported and tried the next night', r5.ok === true && r5.minutes === 0 && r5.errors.some(e => /November board meeting/.test(e.family)) && !mtg(db5).drive_draft_file_id, short(r5));
    check('…and shows as the Drive card\'s last error', /PDF upload failed|boom/.test(db5.tables.google_drive_grants[0].last_error || ''), db5.tables.google_drive_grants[0].last_error);
  }
}

// ── Wiring ──────────────────────────────────────────────────────────────
console.log('\nWiring');
const bm = read('supabase/functions/board_meetings/index.ts');
const part = (src, start, end) => { const i = src.indexOf(start); if (i < 0) return ''; const j = src.indexOf(end, i + start.length); return src.slice(i, j < 0 ? undefined : j); };
check('board_meetings uses the Drive backup', /from '\.\.\/_shared\/drive_minutes\.ts'/.test(bm));
check('BV6: in the background, after the page has its answer', /waitUntil/.test(bm) && /function driveLater/.test(bm));
check('BV3: Close meeting saves the draft', /driveLater\(/.test(part(bm, "action === 'finalize'", '// ── Minutes approval')));
check('BV3: Save changes and an amendment rewrite it', /driveLater\(/.test(part(bm, "action === 'amend'", "action === 'finalize'")));
check('BV4: the last approval adds the approved file (submit and approve)', /driveLater\(/.test(part(bm, 'async function postIfDone', '// ── Agenda items')));
check('BV5: a new bylaws version is copied', /bylawsLater\(|driveBylawsLater\(/.test(part(bm, "action === 'set_bylaws'", "action === 'list'")));
const gs = read('supabase/functions/google_drive_sync/index.ts');
check('reconnecting Drive forgets the Board minutes folder too', /minutes_folder_id: null/.test(gs));
const dpSrc = read('supabase/functions/_shared/drive_parties.ts');
check('the nightly run has the minutes step', /catchUpMinutes\(/.test(dpSrc));
const migDir = new URL('supabase/migrations/', root);
const mig = readdirSync(migDir).filter(f => /minutes_drive/.test(f)).map(f => readFileSync(new URL(f, migDir), 'utf8')).join('\n');
check('one migration adds the tracking columns', /drive_draft_file_id/.test(mig) && /drive_draft_hash/.test(mig) && /drive_posted_count/.test(mig) && /club_documents[\s\S]*drive_file_id/.test(mig) && /minutes_folder_id/.test(mig), mig ? '' : 'no *_minutes_drive.sql');
const settings = read('club/admin/settings.html');
check('Settings → Backups & archive says minutes and bylaws are copied', /board minutes and bylaws/i.test(settings));
check('the Drive help article says so', /Board minutes/.test(read('club/admin/help/articles/drive-backup.md')));
check('the board minutes article says so', /Google Drive/.test(read('club/admin/help/articles/board-minutes.md')));
check('the offline CI runs this test', /\btest_minutes_drive\b/.test(read('.github/workflows/offline-tests.yml')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

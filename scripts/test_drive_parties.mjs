#!/usr/bin/env node
// Parties in the Drive backup, and the nightly catch-up (PLAN.md BP).
// Offline: the real code runs against a pretend Google and database
// (scripts/lib/fake_google.mjs). Costs nothing.
// --live also checks the database trigger on a throwaway club (a few SQL
// queries, no function calls), deleted afterwards.
//
// Usage: node scripts/test_drive_parties.mjs [--live]
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeGoogle, fakeDb } from './lib/fake_google.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
const realFetch = globalThis.fetch;   // the pretend Google replaces fetch; the live part needs the real one
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 400);
const remap = { 'https://esm.sh/pdf-lib@1.17.1': new URL('lib/pdf_lib_fake.mjs', import.meta.url).href };
const load = async rel => { try { return await importTs(new URL(rel, root), { remap }); } catch (e) { console.log(`  (${rel} did not load: ${e.message})`); return null; } };
const ph = await load('supabase/functions/_shared/party_history.ts');
const dp = await load('supabase/functions/_shared/drive_parties.ts');

const TZ = 'America/Los_Angeles';
const TID = 't1';
const base = { tenant_id: TID, family_name: 'Smith', title: 'Birthday', expected_guests: 20, price_cents: 15000,
  starts_at: '2027-07-12T21:00:00Z', ends_at: '2027-07-13T00:00:00Z', created_at: '2026-11-03T18:00:00Z', payment_method: null, note: null, decided_at: null };
const step = (booking_id, at, op, over = {}) => ({ booking_id, at, op, ...base, ...over });

// ── The steps of a party ────────────────────────────────────────────────
console.log('BP1 · what happened to a party (offline)');
check('party_history.ts exists', !!ph);
if (ph) {
  const life = [
    step('b1', '2026-11-03T18:00:00Z', 'insert', { status: 'pending', payment_status: 'unpaid' }),
    step('b1', '2026-11-04T18:00:00Z', 'update', { status: 'approved', payment_status: 'unpaid', decided_at: '2026-11-04T18:00:00Z' }),
    step('b1', '2026-11-05T18:00:00Z', 'update', { status: 'approved', payment_status: 'pending_verify', payment_method: 'venmo', decided_at: '2026-11-04T18:00:00Z' }),
    step('b1', '2026-11-06T18:00:00Z', 'update', { status: 'approved', payment_status: 'paid', payment_method: 'venmo', decided_at: '2026-11-04T18:00:00Z' }),
    step('b1', '2026-11-07T18:00:00Z', 'update', { status: 'approved', payment_status: 'paid', payment_method: 'venmo', decided_at: '2026-11-04T18:00:00Z', starts_at: '2027-07-19T21:00:00Z', ends_at: '2027-07-20T00:00:00Z' }),
    step('b1', '2026-11-20T18:00:00Z', 'update', { status: 'cancelled', payment_status: 'paid', payment_method: 'venmo', decided_at: '2026-11-04T18:00:00Z', starts_at: '2027-07-19T21:00:00Z', ends_at: '2027-07-20T00:00:00Z' }),
  ];
  const s = ph.partySteps(life, [], TZ);
  check('requested, approved, Venmo sent, paid, moved, canceled: each with its date', s.length === 6
    && /^Nov 3: requested/.test(s[0]) && /^Nov 4: approved/.test(s[1]) && /^Nov 5: Venmo sent/.test(s[2])
    && /^Nov 6: paid by Venmo \$150\.00/.test(s[3]) && /^Nov 7: moved to .*Jul 19.*2:00.5:00 PM/.test(s[4]) && /^Nov 20: canceled by the family/.test(s[5]), short(s));
  check('its status: canceled after it was paid', /^Canceled/.test(ph.partyStatus(life.at(-1), [])) && /paid/i.test(ph.partyStatus(life.at(-1), [])), ph.partyStatus(life.at(-1), []));

  const board = [life[0], life[1], step('b2', '2026-11-08T18:00:00Z', 'update', { status: 'cancelled', payment_status: 'unpaid', decided_at: '2026-11-08T18:00:00Z', note: 'Pool closed for repairs' })];
  check('the board canceling, with its note', /^Nov 8: canceled by the board \(Pool closed for repairs\)/.test(ph.partySteps(board, [], TZ).at(-1)), short(ph.partySteps(board, [], TZ)));
  const released = [life[0], life[1], step('b3', '2026-11-08T18:00:00Z', 'update', { status: 'cancelled', payment_status: 'unpaid', decided_at: '2026-11-04T18:00:00Z', note: 'Released: not paid within 3 days of approval.' })];
  check('released for not paying in time', /^Nov 8: released: not paid within 3 days/.test(ph.partySteps(released, [], TZ).at(-1)), short(ph.partySteps(released, [], TZ)));
  const auto = [life[0], life[1], step('b4', '2026-11-05T18:00:00Z', 'update', { status: 'cancelled', payment_status: 'paid', payment_method: 'stripe', decided_at: '2026-11-04T18:00:00Z', note: 'Auto-cancelled: another party was booked for this time first. REFUND THIS MEMBER.' })];
  const as = ph.partySteps(auto, [], TZ);
  check('paid by card, then canceled automatically: the time was taken', /^Nov 5: paid by card \$150\.00/.test(as.at(-2)) && /^Nov 5: canceled automatically/.test(as.at(-1)) && /refund/i.test(as.at(-1)), short(as));
  const refunds = [{ entity_id: 'b4', kind: 'payment.refund', created_at: '2026-11-09T18:00:00Z', summary: '[REVIEW] Stripe refund on a party (Birthday) (Smith): $150.00. Nothing was changed in Poolside.' }];
  check('a Stripe refund is a step', /^Nov 9: refunded \$150\.00 in Stripe/.test(ph.partySteps(auto, refunds, TZ).at(-1)), short(ph.partySteps(auto, refunds, TZ)));
  check('and the status says refunded', /refunded/i.test(ph.partyStatus(auto.at(-1), refunds)), ph.partyStatus(auto.at(-1), refunds));
  const turned = [life[0], step('b5', '2026-11-04T18:00:00Z', 'update', { status: 'rejected', payment_status: 'unpaid', decided_at: '2026-11-04T18:00:00Z', note: 'Swim meet that day' })];
  check('turned down, with the board\'s note', /^Nov 4: turned down \(Swim meet that day\)/.test(ph.partySteps(turned, [], TZ).at(-1)) && /Turned down/.test(ph.partyStatus(turned.at(-1), [])), short(ph.partySteps(turned, [], TZ)));
  const snap = [step('b6', '2026-10-02T18:00:00Z', 'snapshot', { status: 'approved', payment_status: 'paid', payment_method: 'stripe', created_at: '2026-10-01T18:00:00Z' })];
  const ss = ph.partySteps(snap, [], TZ);
  check('a party from before this started: requested, then where it stood', /^Oct 1: requested/.test(ss[0]) && /^Oct 2: .*approved.*paid by card \$150\.00/.test(ss[1]), short(ss));
  check('booked and paid', /^Booked/.test(ph.partyStatus(snap[0], [])), ph.partyStatus(snap[0], []));
  const rec = ph.partyRecord(life, [], TZ);
  check('a row: date, time, family, party, guests, amount, paid by, status, what happened, requested, ID',
    rec['Party Date'] === '=DATE(2027,7,19)' && /2:00.5:00 PM/.test(rec['Time']) && rec.Family === 'Smith' && rec.Party === 'Birthday' && rec.Guests === 20
    && rec.Amount === '$150.00' && rec['Paid By'] === 'Venmo' && /^Canceled/.test(rec.Status) && /^Nov 3: requested\n[\s\S]*\nNov 20: canceled by the family$/.test(rec['What happened'])
    && /^=DATE\(2026,11,3\)\+TIME\(10,0,0\)$/.test(rec.Requested) && rec['Party ID'] === 'b1', short(rec));
  check('a family name starting with = stays text', ph.partyRecord([step('b7', '2026-11-03T18:00:00Z', 'insert', { status: 'pending', payment_status: 'unpaid', family_name: '=1+1' })], [], TZ).Family === "'=1+1");
}

// ── The Parties tab ─────────────────────────────────────────────────────
function club() {
  return fakeDb({
    tenants: [{ id: TID, slug: 'bishopestates', display_name: 'Bishop Estates Cabana Club', timezone: TZ }],
    policies: [{ tenant_id: TID, slug: 'waiver', title: 'Waiver', body: 'Swim at your own risk.', sort_order: 1 }],
    settings: [{ tenant_id: TID, value: { membership_tiers: [{ slug: 'family', label: 'Family' }] } }],
    google_drive_grants: [{ tenant_id: TID, refresh_token: 'rt', connected_email: 'board@example.com', root_folder_id: null, club_folder_id: null, spreadsheet_id: null, year_folder_ids: {}, year_tab_ids: {} }],
    applications: [], drive_sync_log: [], drive_sync_queue: [], party_history: [], audit_log: [],
  });
}
const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo'.padEnd(120, 'A');
const app = (id, over = {}) => ({ id, tenant_id: TID, created_at: '2026-11-03T20:15:00Z', membership_year: 2027, is_renewal: false, status: 'pending',
  family_name: 'Fam ' + id, primary_name: 'P ' + id, primary_email: `${id}@example.com`, primary_phone: '+14085550001', address: '1 Pool Way', city: 'San Jose', zip: '95123',
  emergency_contact: null, num_adults: 1, num_kids: 0, tier_slug: 'family', payment_method: 'stripe', payment_status: 'unpaid',
  adults_json: [{ name: 'P ' + id, signature_url: SIG }], children_json: [], waivers_accepted: { waiver: true }, accepted_at: '2026-11-03T20:15:00Z', signature_primary: null, ...over });
const tab = (g, sid, title) => g.sheets[sid]?.tabs.find(t => t.title === title);
const rowsOf = t => { if (!t) return []; const [h, ...rs] = t.rows; return rs.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };

if (dp && ph) {
  console.log('\nBP2 · the Parties tab (pretend Google)');
  const g = fakeGoogle(); globalThis.fetch = g.fetch;
  const db = club();
  db.tables.party_history.push(
    step('late', '2026-11-03T18:00:00Z', 'insert', { status: 'pending', payment_status: 'unpaid', family_name: 'Late', starts_at: '2027-08-01T21:00:00Z', ends_at: '2027-08-02T00:00:00Z' }),
    step('early', '2026-11-03T19:00:00Z', 'insert', { status: 'pending', payment_status: 'unpaid', family_name: 'Early', starts_at: '2027-06-05T21:00:00Z', ends_at: '2027-06-06T00:00:00Z' }),
  );
  const r1 = await dp.nightlyDrive(db, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  const sid = db.tables.google_drive_grants[0].spreadsheet_id;
  const pt = tab(g, sid, 'Parties');
  check('a Parties tab in the roster sheet', !!sid && !!pt, short({ r1, tabs: g.sheets[sid]?.tabs.map(t => t.title) }));
  let rows = rowsOf(pt);
  check('one row per party, by party date', rows.length === 2 && rows[0]['Party ID'] === 'early' && rows[1]['Party ID'] === 'late', short(rows.map(r => r['Party ID'])));
  check('the header row is the Parties columns', pt?.rows[0]?.join('|') === ph.PARTY_COLUMNS.map(c => c.label).join('|'), short(pt?.rows[0]));

  // A row someone kept from a party since deleted in Poolside stays.
  pt.rows.push(pt.rows[1].map((v, i) => (pt.rows[0][i] === 'Party ID' ? 'gone' : pt.rows[0][i] === 'Family' ? 'Deleted Fam' : pt.rows[0][i] === 'Party Date' ? '=DATE(2027,7,1)' : v)));
  db.tables.party_history.push(step('early', '2026-11-04T18:00:00Z', 'update', { status: 'approved', payment_status: 'unpaid', family_name: 'Early', decided_at: '2026-11-04T18:00:00Z', starts_at: '2027-06-05T21:00:00Z', ends_at: '2027-06-06T00:00:00Z' }));
  await dp.nightlyDrive(db, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  rows = rowsOf(tab(g, sid, 'Parties'));
  check('the next night: updated in place, not added again', rows.filter(r => r['Party ID'] === 'early').length === 1 && /approved/.test(rows.find(r => r['Party ID'] === 'early')?.['What happened'] ?? ''), short(rows));
  check('a party deleted in Poolside keeps its row, in date order', rows.length === 3 && rows.map(r => r['Party ID']).join(',') === 'early,gone,late', short(rows.map(r => r['Party ID'])));
  db.tables.applications.push(app('first-signup'));
  await dp.nightlyDrive(db, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  const tabsNow = g.sheets[sid].tabs.map(t => t.title);
  check('a season tab made later goes before Parties, which stays last', tabsNow.join(',') === '2027,Parties', short(tabsNow));

  console.log('\nBP3 · the nightly catch-up (pretend Google)');
  const g2 = fakeGoogle(); globalThis.fetch = g2.fetch;
  const db2 = club();
  db2.tables.applications.push(
    app('queued'), app('missed'),
    app('imported', { status: 'prefilled', adults_json: [{ name: 'P imported' }], accepted_at: null }),
    app('renew-unsigned', { is_renewal: true, adults_json: [{ name: 'P r' }], accepted_at: null }),
    app('renew-signed', { is_renewal: true, adults_json: [{ name: 'P rs' }], signature_primary: SIG }),
  );
  db2.tables.drive_sync_queue.push({ id: 'q1', tenant_id: TID, application_id: 'queued', status: 'pending', attempts: 1, next_retry_at: '2099-01-01T00:00:00Z', created_at: '2026-11-03T20:16:00Z' });
  const r2 = await dp.nightlyDrive(db2, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  const synced = db2.tables.drive_sync_log.map(l => l.application_id).sort();
  check('a waiting backup is retried, even inside its wait', synced.includes('queued') && db2.tables.drive_sync_queue.find(q => q.id === 'q1')?.status === 'done', short({ synced, q: db2.tables.drive_sync_queue }));
  check('a signup that never got copied is copied', synced.includes('missed'), short(synced));
  check('a signed renewal is copied; an unsigned one and an imported family that hasn\'t signed are not', synced.includes('renew-signed') && !synced.includes('renew-unsigned') && !synced.includes('imported'), short(synced));
  check('it reports what it did', r2 && r2.ok && r2.copied >= 2 && r2.retried >= 1 && typeof r2.parties === 'number', short(r2));
  const r3 = await dp.nightlyDrive(db2, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  check('a second run copies nothing again', db2.tables.drive_sync_log.length === synced.length && r3.copied === 0, short(r3));
  const gone = club(); gone.tables.google_drive_grants = [];
  check('a club without Drive is skipped', (await dp.nightlyDrive(gone, TID, { googleClientId: 'cid', googleClientSecret: 'cs' })).skipped === true);
}

if (dp && ph) {
  console.log('\nBQ · connecting, and a new Google account (pretend Google)');
  const g5 = fakeGoogle(); globalThis.fetch = g5.fetch;
  const db5 = club();
  // Copied before into a sheet this account can't see (the old account, or a trashed folder).
  db5.tables.applications.push(app('old-copy'), app('never'));
  db5.tables.drive_sync_log.push({ id: 'l1', tenant_id: TID, application_id: 'old-copy', spreadsheet_id: 'someone-elses-sheet', tab_name: '2027', row_index: 2 });
  const r5 = await dp.nightlyDrive(db5, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  const sid5 = db5.tables.google_drive_grants[0].spreadsheet_id;
  const inSheet = rowsOf(tab(g5, sid5, '2027')).map(r => r['App ID']).sort();
  check('BQ2: a signup copied into another sheet is copied again into this one', inSheet.join(',') === 'never,old-copy', short({ inSheet, r5 }));
  check('BQ2: and its record now points at this sheet', db5.tables.drive_sync_log.filter(l => l.application_id === 'old-copy').length === 1
    && db5.tables.drive_sync_log.find(l => l.application_id === 'old-copy')?.spreadsheet_id === sid5, short(db5.tables.drive_sync_log));
  await dp.nightlyDrive(db5, TID, { googleClientId: 'cid', googleClientSecret: 'cs' });
  check('BQ2: the same account again copies nothing twice', rowsOf(tab(g5, sid5, '2027')).length === 2, String(rowsOf(tab(g5, sid5, '2027')).length));
  check('BQ1: the run sets the last backup time, even with nothing to copy', !!db5.tables.google_drive_grants[0].last_sync_at && db5.tables.google_drive_grants[0].last_error === null, short(db5.tables.google_drive_grants[0]));
}

// ── Wiring ──────────────────────────────────────────────────────────────
console.log('\nBP1, BP3 · wiring (offline)');
const migs = readdirSync(new URL('supabase/migrations/', root));
const histMig = migs.find(f => /party_history/.test(f));
const hm = histMig ? read(`supabase/migrations/${histMig}`) : '';
check('BP1: a migration file for party_history', !!histMig);
check('BP1: a trigger after insert or update on party_bookings', /create trigger[\s\S]*after insert or update on public\.party_bookings/i.test(hm));
check('BP1: booking_id has no foreign key, so the history outlives a deleted family', /booking_id\s+uuid not null,/.test(hm) && !/booking_id[^,\n]*references/i.test(hm));
check('BP1: only a change of status, payment, time or price adds a step', /is not distinct from old\.status/.test(hm) && /is not distinct from old\.payment_status/.test(hm) && /is not distinct from old\.starts_at/.test(hm) && /is not distinct from old\.price_cents/.test(hm));
check('BP1: row level security on, and today\'s parties start their history', /enable row level security/i.test(hm) && /'snapshot'/.test(hm));
const cronMig = migs.find(f => /drive_nightly/.test(f));
const cm = cronMig ? read(`supabase/migrations/${cronMig}`) : '';
check('BP3: a nightly job, about 2 AM Pacific, not callable from outside', /cron\.schedule\(\s*'drive_nightly',\s*'0 10 \* \* \*'/.test(cm) && /revoke execute on function public\.run_drive_nightly_cron\(\) from anon, authenticated/.test(cm) && /'cron_nightly'/.test(cm));
const gds = read('supabase/functions/google_drive_sync/index.ts');
const cronPart = gds.slice(gds.indexOf("action === 'cron_nightly'"), gds.indexOf("action === 'cron_nightly'") + 1500);
check('BP3: cron_nightly needs the cron secret and runs every connected club', /x-cron-secret/.test(cronPart) && /CRON_SECRET/.test(cronPart) && /google_drive_grants/.test(cronPart) && /nightlyDrive\(/.test(cronPart));
const cb = gds.slice(gds.indexOf("if (req.method === 'GET')"), gds.indexOf("if (req.method !== 'POST')"));
check('BQ1: connecting starts the catch-up, without holding up the page', /nightlyDrive\(/.test(cb) && /waitUntil/.test(cb) && cb.indexOf('nightlyDrive(') > cb.indexOf("from('google_drive_grants').upsert"));
const st = read('club/admin/settings.html');
check('BQ3: no Retry, Copy or Reapply buttons on Settings', !/drive-retry-btn|drive-backfill-btn|drive-reformat-btn|retryDriveQueue|backfillDrive|reformatDriveTabs/.test(st));
check('BQ3: and the help article doesn\'t send anyone to them', !/Retry failed syncs|Copy anything missing|Reapply/.test(read('club/admin/help/articles/drive-backup.md')));
check('the Settings card says parties and nightly', /parties/i.test(st.slice(st.indexOf('id="drive-card"'), st.indexOf('id="drive-status"'))) && /night/i.test(st.slice(st.indexOf('id="drive-card"'), st.indexOf('id="drive-status"'))));

// ── Live: the trigger, on a throwaway club ──────────────────────────────
if (LIVE) {
  console.log('\nLive · the trigger (throwaway club, SQL only)');
  const { makeTempClub, dropTempClub } = await import('./lib/testdata.mjs');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await realFetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, { method: 'POST',
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-parties/1.0' }, body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const c = await makeTempClub(sql, 'parties');
  try {
    const [hh] = await sql(`insert into households (tenant_id, family_name) values ('${c.id}', 'SimTest Party Fam') returning id`);
    const [bk] = await sql(`insert into party_bookings (tenant_id, household_id, title, starts_at, ends_at, expected_guests, status, payment_status, price_cents)
      values ('${c.id}', '${hh.id}', 'Birthday', '2027-07-12T21:00:00Z', '2027-07-13T00:00:00Z', 20, 'pending', 'unpaid', 15000) returning id`);
    await sql(`update party_bookings set status = 'approved', decided_at = now() where id = '${bk.id}'`);
    await sql(`update party_bookings set admin_notes = 'just a note' where id = '${bk.id}'`);
    await sql(`update party_bookings set payment_status = 'paid', payment_method = 'stripe', paid_at = now() where id = '${bk.id}'`);
    await sql(`update party_bookings set status = 'cancelled' where id = '${bk.id}'`);
    const h = await sql(`select op, status, payment_status, family_name from party_history where booking_id = '${bk.id}' order by at, id`);
    check('each step is recorded, a note-only change is not', h.map(x => `${x.op}:${x.status}/${x.payment_status}`).join(' ') === 'insert:pending/unpaid update:approved/unpaid update:approved/paid update:cancelled/paid', short(h));
    check('with the family name', h.every(x => x.family_name === 'SimTest Party Fam'), short(h));
    await sql(`delete from households where id = '${hh.id}'`);
    const [{ n }] = await sql(`select count(*)::int as n from party_history where booking_id = '${bk.id}'`);
    check('deleting the family deletes the party, not its history', n === 4, String(n));
  } catch (e) {
    check('live run', false, e.message);
  } finally {
    const left = await dropTempClub(sql, c);
    const [{ n }] = await sql(`select count(*)::int as n from party_history where tenant_id = '${c.id}'`);
    check('cleanup: the throwaway club and its history are gone', left === 0 && n === 0, `${left}/${n}`);
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

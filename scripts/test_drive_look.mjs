#!/usr/bin/env node
// The roster's look, its keyfob numbers, and the nightly rewrite (PLAN.md BR).
// Offline: the real code runs against a pretend Google and database
// (scripts/lib/fake_google.mjs), which keeps each tab's look too. Costs nothing.
//
// Usage: node scripts/test_drive_look.mjs
import { importTs } from './lib/importts.mjs';
import { fakeGoogle, fakeDb } from './lib/fake_google.mjs';

const root = new URL('../', import.meta.url);
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 400);
const remap = { 'https://esm.sh/pdf-lib@1.17.1': new URL('lib/pdf_lib_fake.mjs', import.meta.url).href };
const load = async rel => { try { return await importTs(new URL(rel, root), { remap }); } catch (e) { console.log(`  (${rel} did not load: ${e.message})`); return null; } };
const row = await load('supabase/functions/_shared/drive_row.ts');
const look = await load('supabase/functions/_shared/sheet_look.ts');
const gd = await load('supabase/functions/_shared/google_drive.ts');
const dp = await load('supabase/functions/_shared/drive_parties.ts');
const sync = await load('supabase/functions/_shared/sync_application.ts');

const TZ = 'America/Los_Angeles', TID = 't1';
const SIG = 'data:image/png;base64,' + 'iVBORw0KGgo'.padEnd(120, 'A');
const KEYS = { googleClientId: 'cid', googleClientSecret: 'cs' };
// Doug, 11/3: Submitted right after the family.
const ROSTER = ['Family', 'Submitted', 'Status', 'Type', 'Primary Contact', 'Phone', 'Email', 'Address', 'City', 'Zip', 'Other Adults', 'Children',
  'Adults', 'Kids', 'Keyfobs', 'Tier', 'Paid By', 'Verified', 'Policies', 'Emergency Contact', 'Application PDF', 'App ID'];

// ── What goes in a cell ─────────────────────────────────────────────────
console.log('BR3, BR4, BR5 · what the cells say (offline)');
check('drive_row.ts and sheet_look.ts load', !!row && !!look);
if (row) {
  check('BR3: children by name only, no birthday', row.kidsCell([{ name: 'Tim', dob: '2015-04-02' }, { name: 'Sue' }]) === 'Tim, Sue', row.kidsCell([{ name: 'Tim', dob: '2015-04-02' }, { name: 'Sue' }]));
  const adults = [{ name: 'Sam Smith', phone: '+14085550001' }, { name: 'Jo Smith', phone: '+14085550002', email: 'jo@example.com' }, { name: 'Ann Smith', email: 'ann@example.com' }];
  check('BR1: other adults, one per line', row.adultsCell(adults, 'Sam Smith') === 'Jo Smith · 408-555-0002 · jo@example.com\nAnn Smith · ann@example.com', short(row.adultsCell(adults, 'Sam Smith')));
  check('BR4: working fobs one per line, and how many are waiting', row.fobsCell(['12345', '12346'], 1, null) === '12345\n12346\n1 waiting to be issued', short(row.fobsCell(['12345', '12346'], 1, null)));
  check('BR4: an imported family not approved yet: the numbers from the club\'s list', row.fobsCell([], 0, '55555, 55556') === '55555\n55556', short(row.fobsCell([], 0, '55555, 55556')));
  check('BR4: none at all is blank', row.fobsCell([], 0, null) === '');
  const st = a => row.appStatus({ status: 'pending', payment_status: 'unpaid', is_renewal: false, ...a });
  check('BR5: the Status column says where each one stands',
    st({ status: 'approved', payment_status: 'paid' }) === 'Approved' && st({}) === 'Not paid yet' && st({ payment_status: 'paid' }) === 'Paid, waiting for approval'
    && st({ payment_status: 'pending_verify' }) === 'Venmo to check' && st({ status: 'rejected' }) === 'Turned down'
    && st({ status: 'prefilled' }) === 'Imported, not signed yet' && st({ status: 'prefilled', is_renewal: true }) === 'Renewal not signed yet'
    && st({ is_renewal: true }) === 'Renewal not signed yet' && st({ is_renewal: true, accepted_at: 'x', signature_primary: SIG }) === 'Not paid yet',
    short(['approved', 'pending', 'paid', 'venmo', 'rejected', 'prefilled', 'renewal'].map((_, i) => i)));
}
if (look) {
  const w = look.fitWidths(['Email', 'Other Adults', 'Submitted', 'Application PDF'],
    [['averyveryverylongemailaddress@example.com', 'Jo Smith · 408-555-0002 · jo@example.com\nAnn', '=DATE(2026,11,3)+TIME(12,15,0)', '=HYPERLINK("https://drive.google.com/file/d/abc/view","📄 Open")']]);
  check('BR1: a column is as wide as its longest line', w[0] >= 41 * 7 && w[1] >= 40 * 7 && w[1] < 60 * 7, short(w));
  check('BR1: a date or link is measured as shown, not as its formula', w[2] < 260 && w[3] < 170, short(w));
  check('BR1: and never narrower than its header', look.fitWidths(['Emergency Contact'], [['x']])[0] >= 'Emergency Contact'.length * 8, short(look.fitWidths(['Emergency Contact'], [['x']])));
}

// ── The nightly rewrite ─────────────────────────────────────────────────
function club() {
  return fakeDb({
    tenants: [{ id: TID, slug: 'bishopestates', display_name: 'Bishop Estates Cabana Club', timezone: TZ }],
    policies: [{ tenant_id: TID, slug: 'waiver', title: 'Waiver', body: 'Swim at your own risk.', sort_order: 1 }],
    settings: [{ tenant_id: TID, value: { membership_tiers: [{ slug: 'family', label: 'Family' }] } }],
    google_drive_grants: [{ tenant_id: TID, refresh_token: 'rt', connected_email: 'board@example.com', root_folder_id: null, club_folder_id: null, spreadsheet_id: null, year_folder_ids: {}, year_tab_ids: {} }],
    households: [{ id: 'h1', tenant_id: TID, family_name: 'Smith', fob_number: '12345, 12346' }],
    keyfobs: [
      { id: 'k1', tenant_id: TID, household_id: 'h1', card_number: 12345, status: 'active', issued_at: '2026-11-04T00:00:00Z' },
      { id: 'k2', tenant_id: TID, household_id: 'h1', card_number: 12346, status: 'active', issued_at: '2026-11-04T00:01:00Z' },
      { id: 'k3', tenant_id: TID, household_id: 'h1', card_number: null, status: 'requested' },
      { id: 'k4', tenant_id: TID, household_id: 'h1', card_number: 99999, status: 'off' },
    ],
    applications: [], drive_sync_log: [], drive_sync_queue: [], party_history: [], audit_log: [],
  });
}
const app = (id, over = {}) => ({ id, tenant_id: TID, created_at: '2026-11-03T20:15:00Z', membership_year: 2027, is_renewal: false, status: 'pending',
  family_name: 'Fam ' + id, primary_name: 'P ' + id, primary_email: `${id}@example.com`, primary_phone: '+14085550001', address: '1 Pool Way', city: 'San Jose', zip: '95123',
  emergency_contact: 'Pat — (408)-555-0003', num_adults: 1, num_kids: 0, tier_slug: 'family', payment_method: 'stripe', payment_status: 'unpaid', household_id: null,
  adults_json: [{ name: 'P ' + id, signature_url: SIG }], children_json: [], waivers_accepted: { waiver: true }, accepted_at: '2026-11-03T20:15:00Z', signature_primary: null, ...over });
const tabOf = (g, sid, title) => g.sheets[sid]?.tabs.find(t => t.title === title);
const rowsOf = t => { if (!t) return []; const [h, ...rs] = t.rows; return rs.filter(r => r.some(v => v !== '' && v != null)).map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))); };
const SUN = { red: 0.961, green: 0.62, blue: 0.043 };

if (row && look && dp && sync) {
  console.log('\nBR5 · the roster, rewritten each night (pretend Google)');
  const g = fakeGoogle(); globalThis.fetch = g.fetch;
  const db = club();
  db.tables.applications.push(
    app('smith', { family_name: 'Smith', primary_name: 'Sam Smith', status: 'approved', payment_status: 'paid', verified_at: '2026-11-05T18:00:00Z', household_id: 'h1', num_adults: 2, num_kids: 1,
      adults_json: [{ name: 'Sam Smith', phone: '+14085550001', signature_url: SIG }, { name: 'Jo Smith', phone: '+14085550002', email: 'jo@example.com', signature_url: SIG }],
      children_json: [{ name: 'Tim', dob: '2015-04-02' }] }),
    app('imported', { family_name: 'Imported', status: 'prefilled', prior_fob_number: '55555, 55556', accepted_at: null, adults_json: [{ name: 'P imported' }] }),
    app('renew', { family_name: 'Renewing', is_renewal: true, accepted_at: null, adults_json: [{ name: 'P renew' }] }),
    app('nope', { family_name: 'Nope', status: 'rejected' }),
  );
  const r1 = await dp.nightlyDrive(db, TID, KEYS);
  const sid = db.tables.google_drive_grants[0].spreadsheet_id;
  const t = tabOf(g, sid, '2027');
  check('the 2027 tab, with the new columns, family first', t && t.rows[0].join('|') === ROSTER.join('|'), short(t?.rows[0]));
  const rows = rowsOf(t); const by = Object.fromEntries(rows.map(r => [r['App ID'], r]));
  check('BR5: a row for each signup, renewal and imported family', rows.length === 4 && ['smith', 'imported', 'renew', 'nope'].every(id => by[id]), short({ r1, ids: rows.map(r => r['App ID']) }));
  check('BR5: each with its status', by.smith?.Status === 'Approved' && by.imported?.Status === 'Imported, not signed yet' && by.renew?.Status === 'Renewal not signed yet' && by.nope?.Status === 'Turned down', short(rows.map(r => r.Status)));
  check('BR4: the family\'s working fobs, and the one waiting', by.smith?.Keyfobs === '12345\n12346\n1 waiting to be issued', short(by.smith?.Keyfobs));
  check('BR4: an imported family\'s numbers from the club\'s list', by.imported?.Keyfobs === '55555\n55556', short(by.imported?.Keyfobs));
  check('BR3: children by name only', by.smith?.Children === 'Tim', short(by.smith?.Children));
  check('only signed ones get a PDF', /HYPERLINK/.test(by.smith?.['Application PDF']) && /HYPERLINK/.test(by.nope?.['Application PDF']) && !by.imported?.['Application PDF'] && !by.renew?.['Application PDF'], short(rows.map(r => r['Application PDF'])));
  check('verified, from Poolside', /^Stripe ✓ Nov 5/.test(String(by.smith?.Verified)), short(by.smith?.Verified));
  check('no formula ended up as text', !t.rows.flat().some(v => /^TEXTFORMULA:/.test(String(v))), short(t.rows.flat().filter(v => /^TEXTFORMULA:/.test(String(v)))));

  console.log('\nBR1, BR2 · the look (pretend Google)');
  const col = l => t.rows[0].indexOf(l);
  check('BR2: the header row and the family column stay put', t.frozen?.rows === 1 && t.frozen?.cols === 1, short(t.frozen));
  const longest = l => Math.max(l.length * 8, ...rows.map(r => Math.max(...String(r[l] ?? '').split('\n').map(x => x.length * 7))));
  const narrow = ROSTER.filter(l => !['Submitted', 'Application PDF'].includes(l) && (t.widths?.[col(l)] ?? 0) < longest(l));
  check('BR1: every column is as wide as what\'s in it', narrow.length === 0, short(narrow.map(l => [l, t.widths?.[col(l)], longest(l)])));
  check('BR1: lists wrap, one per line', ['Other Adults', 'Keyfobs', 'Emergency Contact'].every(l => t.wrap?.has(col(l))) && !t.wrap?.has(col('Family')), short([...(t.wrap || [])]));
  check('BR2: phone and zip stay text', t.text?.has(col('Phone')) && t.text?.has(col('Zip')) && !t.text?.has(col('Submitted')), short([...(t.text || [])]));
  const rulesOn = l => (t.rules || []).filter(r => r.ranges.some(x => x.startColumnIndex === col(l)));
  const green = r => r.booleanRule.format.backgroundColor && r.booleanRule.format.backgroundColor.green > r.booleanRule.format.backgroundColor.red;
  check('BR2: colored chips on Status, Type and Verified', rulesOn('Status').some(r => /Approved/.test(JSON.stringify(r.booleanRule.condition)) && green(r))
    && rulesOn('Type').length >= 2 && rulesOn('Verified').length >= 1, short(t.rules?.map(r => [r.ranges[0].startColumnIndex, r.booleanRule.condition.values?.[0]?.userEnteredValue])));
  check('BR2: banded rows, and a brand-blue tab', (t.banding || []).length === 1 && t.color?.blue > 0.3, short({ b: t.banding, c: t.color }));
  const nRules = (t.rules || []).length;

  console.log('\nBR5 · the next night (pretend Google)');
  db.tables.keyfobs.find(k => k.id === 'k3').status = 'active'; db.tables.keyfobs.find(k => k.id === 'k3').card_number = 12347;
  db.tables.applications = db.tables.applications.filter(a => a.id !== 'nope');
  // The board added a column of its own, with a note on the Smiths.
  t.rows[0].push('Board notes'); const smithAt = t.rows.findIndex(r => r[col('App ID')] === 'smith'); t.rows[smithAt][t.rows[0].length - 1] = 'Pays in June';
  const r2 = await dp.nightlyDrive(db, TID, KEYS).catch(e => ({ ok: false, error: e.message }));
  const t2 = tabOf(g, sid, '2027'); const rows2 = rowsOf(t2); const by2 = Object.fromEntries(rows2.map(r => [r['App ID'], r]));
  check('it runs again cleanly', r2.ok, short(r2));
  check('a fob issued since shows up', by2.smith?.Keyfobs === '12345\n12346\n12347', short(by2.smith?.Keyfobs));
  check('a deleted signup keeps its row, marked', by2.nope?.Status === 'Deleted from Poolside' && by2.nope?.Family === 'Nope' && rows2.length === 4, short(by2.nope));
  check('the board\'s own column and note are kept, after Poolside\'s', t2.rows[0].at(-1) === 'Board notes' && by2.smith?.['Board notes'] === 'Pays in June', short(t2.rows[0].slice(-3)));
  check('the look doesn\'t pile up: one banding, the same rules', (t2.banding || []).length === 1 && (t2.rules || []).length === nRules, short({ b: t2.banding?.length, rules: [nRules, t2.rules?.length] }));

  console.log('\nBR5 · a tab in the earlier layout (pretend Google)');
  const OLD = ['Submitted', 'Family', 'Type', 'Primary Contact', 'Email', 'Phone', 'Other Adults', 'Children', 'Tier', 'Adults', 'Kids', 'Policies', 'Address', 'City', 'Zip', 'Emergency Contact', 'Paid By', 'Verified', 'Application PDF', 'App ID'];
  const g3 = fakeGoogle(); globalThis.fetch = g3.fetch;
  const db3 = club();
  db3.tables.applications.push(app('smith', { family_name: 'Smith', status: 'approved', payment_status: 'paid', household_id: 'h1' }));
  await dp.nightlyDrive(db3, TID, KEYS);
  const sid3 = db3.tables.google_drive_grants[0].spreadsheet_id;
  const t3 = tabOf(g3, sid3, '2027');
  // Put it back the way the 11/3 version wrote it, plus a row only the sheet has.
  const ghost = OLD.map(l => ({ Family: 'Ghost', 'App ID': 'ghost', Phone: '408-555-0009', Children: 'Kid (born 2016-01-01)', Submitted: '=DATE(2026,10,1)+TIME(9,0,0)' }[l] ?? ''));
  t3.rows = [OLD, OLD.map(l => (l === 'App ID' ? 'smith' : l === 'Family' ? 'Smith' : '')), ghost];
  await dp.nightlyDrive(db3, TID, KEYS);
  const rows3 = rowsOf(tabOf(g3, sid3, '2027')); const by3 = Object.fromEntries(rows3.map(r => [r['App ID'], r]));
  check('it\'s rewritten in the new layout', tabOf(g3, sid3, '2027').rows[0].slice(0, ROSTER.length).join('|') === ROSTER.join('|'), short(tabOf(g3, sid3, '2027').rows[0]));
  check('a row only the sheet had moves with its columns', by3.ghost?.Phone === '408-555-0009' && by3.ghost?.Family === 'Ghost' && by3.ghost?.Status === 'Deleted from Poolside', short(by3.ghost));

  console.log('\nBR2 · the Parties tab (pretend Google)');
  db.tables.party_history.push(
    { booking_id: 'p1', tenant_id: TID, at: '2026-11-03T18:00:00Z', op: 'insert', status: 'pending', payment_status: 'unpaid', family_name: 'Smith', title: 'Birthday', expected_guests: 20, price_cents: 15000, starts_at: '2027-07-12T21:00:00Z', ends_at: '2027-07-13T00:00:00Z', created_at: '2026-11-03T18:00:00Z' },
    { booking_id: 'p1', tenant_id: TID, at: '2026-11-04T18:00:00Z', op: 'update', status: 'approved', payment_status: 'unpaid', family_name: 'Smith', title: 'Birthday', expected_guests: 20, price_cents: 15000, starts_at: '2027-07-12T21:00:00Z', ends_at: '2027-07-13T00:00:00Z', created_at: '2026-11-03T18:00:00Z', decided_at: '2026-11-04T18:00:00Z' },
  );
  globalThis.fetch = g.fetch;
  await dp.nightlyDrive(db, TID, KEYS);
  const pt = tabOf(g, sid, 'Parties'); const prow = rowsOf(pt)[0] || {};
  check('each step on its own line', prow['What happened'] === 'Nov 3: requested\nNov 4: approved', short(prow['What happened']));
  const pcol = l => pt.rows[0].indexOf(l);
  check('the steps wrap, the status has chips, and the tab is sun-colored', pt.wrap?.has(pcol('What happened')) && (pt.rules || []).some(r => r.ranges[0].startColumnIndex === pcol('Status'))
    && Math.abs((pt.color?.red ?? 0) - SUN.red) < 0.02 && Math.abs((pt.color?.green ?? 0) - SUN.green) < 0.02, short({ c: pt.color, wrap: [...(pt.wrap || [])] }));
  check('the Parties tab is still last', g.sheets[sid].tabs.at(-1).title === 'Parties', short(g.sheets[sid].tabs.map(x => x.title)));

  console.log('\nA signup the moment it\'s sent (pretend Google)');
  const g4 = fakeGoogle(); globalThis.fetch = g4.fetch;
  const db4 = club(); db4.tables.applications.push(app('fresh', { family_name: 'Fresh', children_json: [{ name: 'Kim', dob: '2018-02-02' }] }));
  const r4 = await sync.syncApplicationToDrive(db4, { tenantId: TID, applicationId: 'fresh', ...KEYS });
  const t4 = tabOf(g4, db4.tables.google_drive_grants[0].spreadsheet_id, '2027'); const f = rowsOf(t4)[0] || {};
  check('its row is there right away, in the new layout, with its status', r4.ok && t4?.rows[0].join('|') === ROSTER.join('|') && f.Family === 'Fresh' && f.Status === 'Not paid yet' && f.Children === 'Kim', short(f));
  check('and a new tab already has the look', t4?.frozen?.cols === 1 && (t4?.rules || []).length > 0 && (t4?.banding || []).length === 1, short({ fr: t4?.frozen, rules: t4?.rules?.length }));
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

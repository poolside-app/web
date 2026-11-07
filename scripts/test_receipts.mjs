#!/usr/bin/env node
// A real PDF receipt for every card payment (PLAN.md BZ, Doug 11/6: "the
// recpeit isn't like an official one... can you make a PDF of some sort?...
// save them in the google backup... make a family folder"). His answers:
// folders like "Smith - 123 Oak St"; no receipts for Venmo ("make sure it
// says board needs to approve... and use the venmo reciept as your
// receipt"); the club's address on it, from what the club enters, with an
// address step in the setup checklist; emailed only, not in the app.
// Offline: the receipt against the pretend database, its PDF against the
// pretend pdf-lib, Drive against the pretend Google, the emails as rendered,
// and the wiring in the functions and pages.
//
// Usage: node scripts/test_receipts.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeGoogle, fakeDb } from './lib/fake_google.mjs';

const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => String(JSON.stringify(v)).slice(0, 300);
const block = (src, start, len = 3000) => { const i = src.indexOf(start); return i < 0 ? '' : src.slice(i, i + len); };

globalThis.Deno = { env: { get: () => undefined } };
const FAKE_PDF = new URL('lib/pdf_lib_fake.mjs', import.meta.url).href;
const remap = { 'https://esm.sh/pdf-lib@1.17.1': FAKE_PDF };
const pdf = await import(FAKE_PDF);
const load = async rel => { try { return await importTs(new URL(rel, root), { remap }); } catch (e) { console.log(`  (${rel} did not load: ${e.message})`); return null; } };
const rc = await load('supabase/functions/_shared/receipts.ts');
const df = await load('supabase/functions/_shared/drive_family.ts');
const et = await load('supabase/functions/_shared/email_template.ts');
const vm = await load('supabase/functions/_shared/venmo.ts');

const TID = 't1';
const KEYS = { googleClientId: 'cid', googleClientSecret: 'cs' };
function club({ address = '1 Pool Lane, Concord, CA 94521' } = {}) {
  return fakeDb({
    tenants: [{ id: TID, slug: 'bishopestates', display_name: 'Bishop Estates Cabana Club', timezone: 'America/Los_Angeles' },
      { id: 't2', slug: 'maple', display_name: 'Maple Grove', timezone: 'America/Los_Angeles' }],
    settings: [{ tenant_id: TID, value: { membership: { year: 2027 }, club: { address, location: 'Concord, California' }, branding: { logo_url: 'https://x.supabase.co/storage/v1/object/public/club-assets/t1/logo.jpg', icon_mode: 'logo', icon_512_url: 'https://x.supabase.co/storage/v1/object/public/club-assets/t1/icon512.png' } } },
      { tenant_id: 't2', value: { membership: { year: 2027 }, club: { location: 'Davis, California' } } }],
    applications: [{ id: 'a1', tenant_id: TID, family_name: 'Smith', address: '123 Oak St', primary_name: 'Sam Smith', primary_email: 'sam@example.com', household_id: null }],
    households: [{ id: 'h1', tenant_id: TID, family_name: 'Lee', address: '9 Elm Ct, Concord, CA' }],
    receipts: [],
    google_drive_grants: [{ tenant_id: TID, refresh_token: 'rt', connected_email: 'board@example.com', root_folder_id: null, club_folder_id: null, spreadsheet_id: null, year_folder_ids: {}, year_tab_ids: {} }],
  });
}
const PAID_AT = '2026-11-06T14:00:02Z';
const signup = (over = {}) => ({ tenantId: TID, paymentRef: 'pi_1', kind: 'membership', applicationId: 'a1',
  lines: [{ label: '2027 membership, Family', cents: 60000 }], totalCents: 61812, paidAt: PAID_AT, paidWith: 'Visa ending 4242', ...over });

console.log('BZ1 · the receipt');
check('_shared/receipts.ts exists', !!rc);
let db = null, r1 = null, r2 = null, again = null, other = null, none = null;
if (rc) {
  db = club();
  r1 = await rc.issueReceipt(db, signup());
  check('numbered per club per season: 2027-0001', r1?.season === 2027 && r1?.number === 1 && rc.receiptNo(r1) === '2027-0001', short(r1));
  check('who paid and where they live, from the signup', r1?.payer_name === 'Sam Smith' && r1?.payer_email === 'sam@example.com' && r1?.family_name === 'Smith' && r1?.family_address === '123 Oak St', short(r1));
  check('the club\'s name and the address it entered', r1?.club_name === 'Bishop Estates Cabana Club' && r1?.club_address === '1 Pool Lane, Concord, CA 94521', short(r1));
  check('the card fee is what the card paid beyond the dues', r1?.card_fee_cents === 1812 && r1?.total_cents === 61812, short(r1));
  r2 = await rc.issueReceipt(db, signup({ paymentRef: 'pi_2', kind: 'party', applicationId: null, householdId: 'h1', lines: [{ label: 'Party on June 14', cents: 15000 }], totalCents: 15000 }));
  check('the next one is 2027-0002, for a family by its household', r2?.number === 2 && r2?.family_name === 'Lee' && r2?.family_address === '9 Elm Ct, Concord, CA' && r2?.card_fee_cents === 0, short(r2));
  again = await rc.issueReceipt(db, signup());
  check('the same payment twice (Stripe sends again): one receipt', again?.id === r1?.id && db.tables.receipts.length === 2, short({ again: again?.id, n: db.tables.receipts.length }));
  other = await rc.issueReceipt(db, signup({ tenantId: 't2', paymentRef: 'pi_9', applicationId: null, payerName: 'Ann Park', familyName: 'Park' }));
  check('another club starts at its own 0001, its address falling back to its location', other?.number === 1 && other?.club_address === 'Davis, California', short(other));
  none = await rc.issueReceipt(db, signup({ paymentRef: 'pi_0', totalCents: 0 }));
  check('nothing charged, no receipt', none === null && db.tables.receipts.length === 3);
  check('its file: "2027 Receipt 0001.pdf"', rc.receiptFileName(r1) === '2027 Receipt 0001.pdf', rc.receiptFileName?.(r1));

  pdf.resetDrawn();
  await rc.renderReceiptPdf(r1);
  const t = pdf.drawn.texts.join('\n');
  check('the PDF: the club and its address', /Bishop Estates Cabana Club/.test(t) && /1 Pool Lane, Concord, CA 94521/.test(t), short(pdf.drawn.texts.slice(0, 6)));
  check('…"Receipt 2027-0001" and the day paid, in pool time', /Receipt 2027-0001/.test(t) && /November 6, 2026/.test(t), short(pdf.drawn.texts.slice(0, 10)));
  check('…who paid', /Sam Smith/.test(t) && /sam@example\.com/.test(t));
  check('…what for, the card fee and the total', /2027 membership, Family/.test(t) && /\$600\.00/.test(t) && /Card fee/.test(t) && /\$18\.12/.test(t) && /Total paid/.test(t) && /\$618\.12/.test(t), short(pdf.drawn.texts));
  check('…and how it was paid', /Paid by Visa ending 4242/.test(t));
  const plan = await rc.issueReceipt(db, signup({ paymentRef: 'pi_3', kind: 'plan', lines: [{ label: '2027 membership: payment 2 of 5', cents: 100 }], totalCents: 134, balanceCents: 300 }));
  pdf.resetDrawn();
  await rc.renderReceiptPdf(plan);
  const tp = pdf.drawn.texts.join('\n');
  check('a plan payment says what\'s left to pay', /Left to pay/.test(tp) && /\$3\.00/.test(tp), short(pdf.drawn.texts));
  const paidOff = await rc.issueReceipt(db, signup({ paymentRef: 'pi_4', kind: 'plan', lines: [{ label: '2027 membership: payment 5 of 5', cents: 100 }], totalCents: 134, balanceCents: 0 }));
  pdf.resetDrawn();
  await rc.renderReceiptPdf(paidOff);
  check('…and the last one says paid in full', /Paid in full/.test(pdf.drawn.texts.join('\n')));

  // Doug 11/6: "add the club logo at the top".
  check('the club\'s logo is kept with the receipt, like its address', r1?.logo_url === 'https://x.supabase.co/storage/v1/object/public/club-assets/t1/logo.jpg' && other?.logo_url == null, short({ a: r1?.logo_url, b: other?.logo_url }));
  const img = bytes => async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array(bytes).buffer });
  const drawWith = async (row, fetchFn) => { pdf.resetDrawn(); await rc.renderReceiptPdf(row, { fetchFn }); return { images: pdf.drawn.images, name: pdf.drawn.texts.includes('Bishop Estates Cabana Club') }; };
  const jpg = await drawWith(r1, img([0xFF, 0xD8, 0xFF, 0xE0, 0, 0]));
  const png = await drawWith(r1, img([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  check('the logo at the top, a JPEG or a PNG, next to the club\'s name', jpg.images === 1 && png.images === 1 && jpg.name && png.name, short({ jpg, png }));
  // Bishop's logo is a WebP photo, which a PDF can't hold: the app icon Poolside made from it (a PNG) instead.
  check('the logo\'s app icon is kept too, when the icon is made from the logo', r1?.logo_icon_url === 'https://x.supabase.co/storage/v1/object/public/club-assets/t1/icon512.png', short(r1?.logo_icon_url));
  const byUrl = map => async url => { const b = map[String(url).split('/').pop()]; if (!b) throw new Error('no file'); return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(b).buffer }; };
  const webp = await drawWith(r1, byUrl({ 'logo.jpg': [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 'icon512.png': [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] }));
  check('a WebP logo: its PNG app icon instead', webp.images === 1 && webp.name, short(webp));
  const svg = await drawWith({ ...r1, logo_icon_url: null }, img([0x3C, 0x73, 0x76, 0x67]));
  const down = await drawWith(r1, async () => { throw new Error('offline'); });
  const noLogo = await drawWith({ ...r1, logo_url: null, logo_icon_url: null }, async () => { throw new Error('not called'); });
  check('a logo it can\'t use, or can\'t fetch: the receipt still comes out, without it', svg.images === 0 && svg.name && down.images === 0 && down.name && noLogo.images === 0 && noLogo.name, short({ svg, down, noLogo }));
  const logoMig = (await import('node:fs')).readdirSync(new URL('supabase/migrations/', root)).filter(f => /receipt/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
  check('…kept in their own columns', /logo_url/.test(logoMig) && /logo_icon_url/.test(logoMig));

  const att = await rc.receiptAttachment(r1);
  check('attached to an email as "2027 Receipt 0001.pdf"', att?.filename === '2027 Receipt 0001.pdf' && att?.contentType === 'application/pdf' && att?.content?.length > 0, short(att));
  const card = brand => rc.cardLabel({ latest_charge: { payment_method_details: { card: { brand, last4: '4242' } } } });
  check('the card: "Visa ending 4242", "American Express ending 4242"', card('visa') === 'Visa ending 4242' && card('amex') === 'American Express ending 4242' && card('mastercard') === 'Mastercard ending 4242', card('visa'));
  check('…or just "Card" when Stripe didn\'t say', rc.cardLabel({}) === 'Card' && rc.cardLabel(null) === 'Card');
  check('the latest receipt for a signup, for its welcome email', (await rc.latestReceipt(db, 'a1'))?.id === paidOff?.id, short(await rc.latestReceipt?.(db, 'a1')));
}
const { readdirSync } = await import('node:fs');
const migSrc = readdirSync(new URL('supabase/migrations/', root)).filter(f => /receipts/.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
check('one migration: the receipts table, numbered once per club and season, one per payment', /create table[^;]*receipts/i.test(migSrc) && /unique \(tenant_id, season, number\)/i.test(migSrc) && /unique \(tenant_id, payment_ref\)/i.test(migSrc), migSrc ? '' : 'no *_receipts.sql');

console.log('\nBZ2 · every card payment, with the email it already sends');
const wh = read('supabase/functions/stripe_webhook/index.ts');
const branch = (start, end) => { const i = wh.indexOf(start); if (i < 0) return ''; const j = wh.indexOf(end, i + start.length); return wh.slice(i, j < 0 ? undefined : j); };
check('a signup or renewal paid by card', /cardReceipt\(/.test(branch("if (kind === 'application' && md.application_id)", "kind.startsWith('payment_plan_')")));
const planB = branch("kind.startsWith('payment_plan_')", "if (kind === 'payment_plan_reactivation'");
check('a plan\'s first payment, a catch-up and a payoff', (planB.match(/cardReceipt\(/g) || []).length >= 2, String((planB.match(/cardReceipt\(/g) || []).length));
check('a reactivation', /cardReceipt\(/.test(branch("if (kind === 'payment_plan_reactivation' && md.plan_id)", 'const fobIds')));
check('keyfobs', /cardReceipt\(/.test(branch("if (kind === 'keyfob' && fobIds.length && tenantId)", "if (kind === 'program_booking'")));
check('a program', /cardReceipt\(/.test(branch("if (kind === 'program_booking' && md.booking_id)", "if (kind === 'party_booking'")));
const partyB = branch("if (kind === 'party_booking' && md.party_id && tenantId)", "if (kind === 'donation'");
check('a party, attached to "Party booked"', /cardReceipt\(/.test(partyB) && /attachments/.test(block(partyB, "templateKey: 'party_confirmed'", 900)));
check('a donation', /cardReceipt\(/.test(branch("if (kind === 'donation' && tenantId)", "if (kind === 'setup_service'")));
check('payments with no email of their own get the new "Payment receipt" email', /emailReceipt\(/.test(wh));
const pp = read('supabase/functions/payment_plans/index.ts');
check('each plan payment the daily run charges, attached to "Plan payment received"', /issueReceipt\(/.test(block(pp, 'async function sendReceipt', 3400)) && /attachments/.test(block(pp, 'async function sendReceipt', 3400)));
check('…with the card it was charged to', /stripeCardLabel\(/.test(block(pp, 'async function chargeInstallment', 4000)));
check('a one-tap renewal, attached to its receipt email', /issueReceipt\(/.test(block(pp, 'async function chargeRenewalWithSavedCard', 6000)) && /attachments/.test(block(pp, "templateKey: 'auto_renew_charged'", 500)));
const apps = read('supabase/functions/applications/index.ts');
check('the welcome email: the signed membership and the receipt', /latestReceipt\(/.test(block(apps, 'let welcomeAttachments', 2500)));
check('"Renewal confirmed" by card carries the receipt', /latestReceipt\(/.test(block(apps, "if (app.payment_status === 'paid' && !body.skip_receipt)", 2200)));
if (et) {
  const reg = et.EMAIL_REGISTRY.find(d => d.key === 'payment_receipt');
  check('a "Payment receipt" email on Settings → Emails, under Payments', reg?.section === 'payments', short(reg?.label));
  const html = (key, vars, x = {}) => et.composeEmail(key, null, null, { tenant_name: 'Bishop Estates Cabana Club', club_url: 'https://b.poolsideapp.com', ...vars }, x).html;
  const att = /Your receipt 2027-0001 is attached/;
  check('…which says what was paid and that the receipt is attached', att.test(html('payment_receipt', { family_name: 'Lee', amount: '$15.75', what: '1 keyfob', receipt_no: '2027-0001' })), '');
  check('"Plan payment received" says its receipt is attached', att.test(html('plan_installment_paid_partial', { family_name: 'Lee', amount: '$1.34', receipt_no: '2027-0001' })));
  check('the welcome email by card, too', att.test(html('application_approved_stripe_paid', { primary_name: 'Sam', receipt_no: '2027-0001' })));
  check('"Renewal confirmed" by card, the one-tap receipt, and "Party booked"', att.test(html('renewal_confirmed', { family_name: 'Lee', season: '2027', amount: '$600.00', paid_by: 'card', receipt_no: '2027-0001' }))
    && att.test(html('auto_renew_charged', { family_name: 'Lee', season: '2027', amount: '$600.00', receipt_no: '2027-0001' }))
    && att.test(html('party_confirmed', { primary_name: 'Sam', party_date: 'June 14', receipt_no: '2027-0001' })));
}

console.log('\nBZ3 · Venmo: no receipt; the board confirms it');
const LINE = 'The board confirms Venmo payments. Your Venmo receipt is your receipt.';
check('one sentence, the same in the server and the pages', vm?.VENMO_RECEIPT_LINE === LINE && read('js/venmo.js').includes(LINE), vm?.VENMO_RECEIPT_LINE);
if (et) {
  const html = (key, vars, x = {}) => et.composeEmail(key, null, null, { tenant_name: 'Bishop', club_url: 'https://b.poolsideapp.com', venmo_handle: 'bishop', ...vars }, x).html;
  const said = h => h.includes(LINE);
  check('in every Venmo email: the signup, the welcome (to pay, and verified), the verified note, the reminder', said(html('application_received_venmo', { primary_name: 'Sam', venmo_link: 'https://venmo.com/x', venmo_code: 'K7Q2' }))
    && said(html('application_approved_unpaid_venmo', { primary_name: 'Sam', venmo_link: 'https://venmo.com/x', venmo_code: 'K7Q2' }))
    && said(html('application_approved_venmo_verified', { primary_name: 'Sam' }))
    && said(html('payment_verified_venmo', { primary_name: 'Sam' }))
    && said(html('dues_reminder_waiting', { primary_name: 'Sam', amount: '$600', venmo_link: 'https://venmo.com/x', venmo_code: 'K7Q2' })));
  check('…a party to pay, and a renewal paid by Venmo', said(html('party_approved_pay', { primary_name: 'Sam', price: '$150' })) && said(html('renewal_confirmed', { family_name: 'Lee', season: '2027', amount: '$600.00', paid_by: 'Venmo' })));
  check('…and never on a card email', !said(html('plan_installment_paid_partial', { family_name: 'Lee', amount: '$1.34', receipt_no: '2027-0001' })));
}
const apply = read('apply.html'), m = read('m/index.html');
check('the signup form\'s Venmo choice says so', /PoolsideVenmo\.RECEIPT_LINE|The board confirms Venmo payments/.test(block(apply, 'Pay with Venmo</div>', 700)));
const mUses = (m.match(/PoolsideVenmo\.RECEIPT_LINE/g) || []).length;
check('so does every Venmo choice in the app: parties, keyfobs, the donation', mUses >= 3, String(mUses));

console.log('\nBZ4 · a folder per family in Drive');
check('_shared/drive_family.ts exists', !!df);
if (df) {
  check('"Smith - 123 Oak St", from the street line', df.familyFolderName('Smith', '123 Oak St, Concord, CA 94521') === 'Smith - 123 Oak St' && df.familyFolderName('Smith', '') === 'Smith' && df.familyFolderName('Smith/Jones', '4 A St') === 'Smith-Jones - 4 A St', df.familyFolderName('Smith', '123 Oak St, Concord, CA 94521'));
  if (rc) {
    const g = fakeGoogle(); globalThis.fetch = g.fetch;
    const d = club();
    await rc.issueReceipt(d, signup());
    const r = await df.backupReceipts(d, TID, KEYS);
    const byId = id => g.files[id];
    const file = Object.values(g.files).find(f => f.name === '2027 Receipt 0001.pdf');
    const fam = file && byId(file.parents[0]);
    const families = fam && byId(fam.parents[0]);
    check('the receipt goes in Families → "Smith - 123 Oak St" as "2027 Receipt 0001.pdf"', !!file && fam?.name === 'Smith - 123 Oak St' && families?.name === 'Families', short(Object.values(g.files).map(f => f.name)));
    check('…remembered, so it\'s copied once', r?.copied === 1 && !!d.tables.receipts[0].drive_file_id, short(r));
    const n = g.calls.filter(c => /upload/.test(c)).length;
    await df.backupReceipts(d, TID, KEYS);
    check('…a second run copies nothing', g.calls.filter(c => /upload/.test(c)).length === n);
  }
}
const sync = read('supabase/functions/_shared/sync_application.ts');
check('the signed membership goes in the family\'s folder as "2027 Membership.pdf"', /familyFolder\(/.test(sync) && /Membership\.pdf/.test(sync) && !/Sign-ups`/.test(sync));
check('the nightly Drive run copies any receipt that was missed', /backupReceipts\(/.test(read('supabase/functions/_shared/drive_parties.ts')));
check('the Backups card and the Drive article say so', /Families/.test(block(read('club/admin/settings.html'), 'When connected, every new application', 900)) && /Families/.test(read('club/admin/help/articles/drive-backup.md')));

console.log('\nBZ5 · the club\'s address');
const st = read('club/admin/settings.html');
check('Settings → Club info has an address box', /id="club_address"/.test(block(st, 'Club info', 1500)));
check('…saved as the club\'s address and loaded back', /address:\s*val\('club_address'\)/.test(st) && /setVal\('club_address',\s*s\.club\?\.address\)/.test(st));
const ts = read('supabase/functions/tenant_settings/index.ts');
check('the setup checklist has an address step', /id: 'address'/.test(ts) && /club\.address/.test(block(ts, "id: 'address'", 300)) && /focus=club_address/.test(block(ts, "id: 'address'", 400)));
check('the help article on receipts', /receipt/i.test(read('club/admin/help/articles/receipts.md')));
check('the offline CI runs this test', /\btest_receipts\b/.test(read('.github/workflows/offline-tests.yml')));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

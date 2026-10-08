#!/usr/bin/env node
// Targeted check for keyfob requests (PLAN.md P). Offline checks read the
// helpers and pages and cost nothing. `--live` adds about 20 Edge Function
// calls on Bishop with a temporary family it removes afterward.
//
// Usage: node scripts/test_keyfobs.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 260);

console.log('P · keyfob rules (offline)');
{
  const k = await importTs(new URL('supabase/functions/_shared/keyfobs.ts', root));
  check('the two printed formats are the same fob: 0000786777 = 012,00345',
    k.parseFobNumber('0000786777').number === 786777 && k.parseFobNumber('012,00345').number === 786777 && k.parseFobNumber('12, 345').number === 786777);
  check('nonsense is refused with a reason', !k.parseFobNumber('abc').ok && !k.parseFobNumber('300,1').ok && !k.parseFobNumber('').ok);
  check('the board sees the last 4 digits', k.fobTail(786777) === '•••6777');
  const s = k.fobSettings({ features: { keyfobs: true }, keyfobs: { included_free: 1, fee_cents: 1500 } });
  check('Bishop: on, 1 included, $15', s.enabled && s.included_free === 1 && s.fee_cents === 1500, short(s));
  check('off unless the club has keyfobs', !k.fobSettings({}).enabled);
  check('a $15 fob by card is $15.76, the card fee on the member', k.fobCardTotal(1500) === Math.ceil(1530 / 0.971), String(k.fobCardTotal(1500)));
  check('addresses compare the way people write them', k.normalizeAddress('4549 Lincoln Dr.') === k.normalizeAddress('4549 lincoln drive') && k.normalizeAddress('12 Oak St') !== k.normalizeAddress('12 Oak Ave'));
}

console.log('P · who is new (offline)');
{
  const apps = read('supabase/functions/applications/index.ts');
  const submit = apps.slice(apps.indexOf("if (action === 'submit')"), apps.indexOf("if (action === 'submit')") + 30000);
  check('the server decides who is new, not the form', /is_new_member:\s+!claimAppId/.test(submit) && !/is_new_member:\s+body\.is_new_member/.test(submit));
  check('a claimed (imported) family keeps its fob number from the list', /claimAppId \? \{\} : \{ prior_fob_number/.test(submit) || /prior_fob_number: claimAppId \?/.test(submit));
  check('step 1 turns away families already on the imported list', /imported: true/.test(apps) && /action === 'resend_claim'/.test(apps));
  check('a signup at a past member\'s address is flagged for the board', /fob_review_note:[^\n]*await addressMatch/.test(submit));
  check('approval asks the board to issue a new family\'s included fob', /reason: 'new_member'/.test(apps) && /kind: 'keyfob\.issue'/.test(apps));
  check('a renewal never gets a free fob', !/reason: 'new_member'/.test(apps.slice(apps.indexOf('renewal_approved') - 4000, apps.indexOf('renewal_approved'))));
}

console.log('P · screens (offline)');
{
  const home = read('m/index.html');
  check('the member app has a Keyfobs card with request and lost', /renderFobCard/.test(home) && /Request another fob/.test(home) && /Report lost/.test(home));
  const apply = read('apply.html');
  check('the signup asks a new family about a keyfob, only when the club has them', /id="need_new_fob"/.test(apply) && /features\?\.keyfobs/.test(apply));
  const desk = read('club/admin/keyfobs.html');
  check('the board has a keyfob desk: issue, lost, add, settings', /action: 'issue'|call\('issue'/.test(desk) && /turned_off/.test(desk) && /call\('add'/.test(desk) && /settings_save/.test(desk));
  check('the desk is in the Settings strip and the nav', /keyfobs\.html/.test(read('js/admin-subtabs.js')));
}

if (LIVE) {
  console.log('\nLive (Bishop, temporary family)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-fobs/1.0' },
      body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const b64 = b => Buffer.from(b).toString('base64url');
  const jwt = p => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 900 })); return `${h}.${body}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`; };
  const fn = async (name, body, token) => {
    const r = await fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' limit 1`);
  const admTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
  const FAMILY = `SimTest Fobs ${String(Date.now()).slice(-6)}`;
  const stamp = String(Date.now()).slice(-7);
  const fobA = 10000000 + Number(stamp.slice(-6)), fobB = fobA + 1;   // under 255,65535, a real fob range
  try {
    const m = await makeTempMember(sql, club.id, FAMILY);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, hid: m.household_id, slug: 'bishopestates' });

    // An imported (prefilled) family can't sign up as new.
    const impPhone = '+1555' + stamp;
    await sql(`insert into applications (tenant_id, family_name, primary_name, primary_email, primary_phone, address, status, payment_status, claim_source, is_new_member)
      values ('${club.id}', '${FAMILY} Imported', 'Imported Tester', 'delivered@resend.dev', '${impPhone}', '99 Testing Way', 'prefilled', 'unpaid', 'csv_import', false)`);
    const c1 = await fn('applications', { action: 'check_contact', slug: 'bishopestates', phone: impPhone, email: 'someone-else@example.com' });
    check('P2: someone on the imported list is sent to their personal link', c1.ok && c1.imported === true, short(c1));
    const rs = await fn('applications', { action: 'resend_claim', slug: 'bishopestates', phone: impPhone, email: '' });
    check('P2: "send me my link" sends it to the phone or email on file', rs.ok, short(rs));

    // The board adds the family's existing fob, then a new member's included fob is issued.
    const add = await fn('keyfobs', { action: 'add', household_id: m.household_id, number: String(fobA) }, admTok);
    check('P4: the board adds a fob a family already has', add.ok && add.fob?.status === 'active', short(add));
    const dup = await fn('keyfobs', { action: 'add', household_id: m.household_id, number: String(fobA) }, admTok);
    check('P4: the same number can\'t go to two live fobs', !dup.ok && /already/.test(dup.error || ''), short(dup));
    const [hh1] = await sql(`select fob_number from households where id = '${m.household_id}'`);
    check('P1: the Members list shows the family\'s fob number', hh1.fob_number === String(fobA), short(hh1));

    // The family asks for another one ($15) and pays by card.
    const mine = await fn('keyfobs', { action: 'mine' }, memTok);
    check('P3: the family sees its fobs and the $15 fee', mine.ok && mine.fobs.length === 1 && mine.fee_cents === 1500 && mine.card_total_cents === 1576, short(mine));
    const req = await fn('keyfobs', { action: 'request' }, memTok);
    check('P3: "Request another fob" makes a $15 request', req.ok && req.fob?.price_cents === 1500 && req.fob?.payment_status === 'unpaid' && !req.fob?.included, short(req));
    const pay = await fn('stripe_checkout', { action: 'keyfob', keyfob_id: req.fob.id }, memTok);
    const tok = pay.url ? new URL(pay.url).hash.replace(/^#t=/, '') : '';
    const amt = tok ? JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).amt : 0;
    check('P3: paying by card charges $15.76', pay.ok && amt === 1576, short({ pay, amt }));
    await fn('stripe_checkout', { action: 'simulate_complete', token: tok });
    const [paid] = await sql(`select payment_status from keyfobs where id = '${req.fob.id}'`);
    const t1 = await sql(`select kind from admin_tasks where source_kind = 'keyfob' and source_id = '${req.fob.id}' and completed_at is null`);
    check('P3: paid, and the board is asked to issue it', paid.payment_status === 'paid' && t1.some(t => t.kind === 'keyfob.issue'), short({ paid, t1 }));
    const iss = await fn('keyfobs', { action: 'issue', id: req.fob.id, number: `${Math.floor(fobB / 65536)},${fobB % 65536}` }, admTok);
    check('P4: the board types the number (either format) and it\'s active', iss.ok && iss.fob?.status === 'active' && Number(iss.fob?.card_number) === fobB, short(iss));

    // Lost: flagged off right away, replacement is $15.
    const lost = await fn('keyfobs', { action: 'report_lost', id: add.fob.id, replace: true }, memTok);
    const [lr] = await sql(`select status from keyfobs where id = '${add.fob.id}'`);
    const t2 = await sql(`select kind from admin_tasks where source_kind = 'keyfob' and source_id = '${add.fob.id}' and completed_at is null`);
    check('P3: a lost fob is flagged to turn off right away', lost.ok && lr.status === 'lost' && t2.some(t => t.kind === 'keyfob.off'), short({ lr, t2 }));
    check('P3: and the replacement costs $15', lost.replacement?.price_cents === 1500 && lost.replacement?.reason === 'replacement', short(lost.replacement));
    const off = await fn('keyfobs', { action: 'turned_off', id: add.fob.id }, admTok);
    const [or] = await sql(`select status from keyfobs where id = '${add.fob.id}'`);
    check('P4: the board marks it turned off at the panel', off.ok && or.status === 'off', short(or));
    const vc = await fn('keyfobs', { action: 'claim_venmo', id: lost.replacement.id }, memTok);
    const cv = await fn('keyfobs', { action: 'confirm_venmo', id: lost.replacement.id }, admTok);
    const [vr] = await sql(`select payment_status from keyfobs where id = '${lost.replacement.id}'`);
    check('P3: Venmo works too, once the board confirms it', vc.ok && cv.ok && vr.payment_status === 'paid', short({ vc, cv, vr }));

    // A new family's included fob, at approval.
    const app = await sql(`insert into applications (tenant_id, family_name, primary_name, primary_email, primary_phone, address, status, payment_status, payment_method, is_new_member, need_new_fob, membership_year)
      values ('${club.id}', '${FAMILY} New', 'New Tester', 'delivered@resend.dev', '+1555${String(Number(stamp) + 1).padStart(7, '0')}', '12 Brand New Ct', 'pending', 'paid', 'stripe', true, true, 2027) returning id`);
    const ap = await fn('applications', { action: 'approve', id: app[0].id }, admTok);
    const nf = await sql(`select k.included, k.reason, k.status, k.payment_status from keyfobs k join applications a on a.household_id = k.household_id where a.id = '${app[0].id}'`);
    check('P2: a new family is approved with its included fob waiting to be issued', ap.ok && nf.length === 1 && nf[0].included && nf[0].reason === 'new_member' && nf[0].payment_status === 'none', short({ ap: ap.ok, nf }));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    await sql(`delete from admin_tasks where source_kind = 'keyfob' and source_id in (select id from keyfobs where household_id in (select id from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%'));
      delete from stripe_processed_events where id in (select 'evt_' || stripe_session_id from keyfobs where household_id in (select id from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%') and stripe_session_id is not null)`);
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    const [{ left }] = await sql(`select (select count(*) from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%') + (select count(*) from applications where tenant_id = '${club.id}' and family_name like '${FAMILY}%') as left`);
    check('cleanup: the temporary families are gone', Number(left) === 0, String(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

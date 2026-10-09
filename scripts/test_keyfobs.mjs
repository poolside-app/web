#!/usr/bin/env node
// Targeted check for keyfob requests and keyfobs at checkout (PLAN.md P, Q).
// Offline checks read the helpers and pages and cost nothing. `--live` adds
// about 35 Edge Function calls on Bishop with temporary families it removes
// afterward.
//
// Usage: node scripts/test_keyfobs.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
const ONLY = process.env.ONLY || '';   // ONLY=cancel: just the X part live
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
  const kh = read('supabase/functions/_shared/keyfobs.ts');
  check('approval asks the board to issue a new family\'s included fob', /reason: 'new_member'/.test(kh) && /kind: 'keyfob\.issue'/.test(kh) && /fobsAtApproval\(/.test(apps));
  check('a renewal never gets a free fob', /isNew: false/.test(apps.slice(apps.indexOf('renewal_approved') - 1500, apps.indexOf('renewal_approved'))));
}

console.log('P · screens (offline)');
{
  const home = read('m/index.html');
  check('the member app has a Keyfobs card with request and lost', /renderFobCard/.test(home) && /Request another fob/.test(home) && /Lost your fob\? Order a new one/.test(home));
  const apply = read('apply.html');
  check('the signup asks a new family about a keyfob, only when the club has them', /id="need_new_fob"/.test(apply) && /features\?\.keyfobs/.test(apply));
  const desk = read('club/admin/keyfobs.html');
  check('the board has a keyfob desk: issue, lost, add, settings', /action: 'issue'|call\('issue'/.test(desk) && /turned_off/.test(desk) && /call\('add'/.test(desk) && /settings_save/.test(desk));
  check('the desk is in the Settings strip and the nav', /keyfobs\.html/.test(read('js/admin-subtabs.js')));
}

console.log('Q · keyfobs at checkout (offline)');
{
  const k = await importTs(new URL('supabase/functions/_shared/keyfobs.ts', root));
  const s = k.fobSettings({ features: { keyfobs: true } });
  check('Q1: 5 fobs per family by default, and the board can change it', s.max_per_family === 5 && k.fobSettings({ keyfobs: { max_per_family: 3 } }).max_per_family === 3, short(s));
  const a = k.fobExtras(s, { requested: 7, have: 0, free: 1 });
  check('Q1: a new family can add up to 4 extras (5 counting the free one), $15 each', a.count === 4 && a.cents === 6000 && a.room === 4, short(a));
  const b = k.fobExtras(s, { requested: 5, have: 2, free: 0 });
  check('Q1: fobs they already have count toward the 5', b.count === 3 && b.cents === 4500, short(b));
  check('Q1: nonsense quantities are 0', k.fobExtras(s, { requested: -2, have: 0, free: 1 }).count === 0 && k.fobExtras(s, { requested: 'x', have: 0, free: 0 }).count === 0);
  const mp = read('supabase/functions/_shared/membership_price.ts');
  check('Q1: extra fobs are part of the membership price', /fobExtras/.test(mp) && /fob_cents/.test(mp) && /fob_extra_count/.test(mp));
  const apps = read('supabase/functions/applications/index.ts');
  const quote = apps.slice(apps.indexOf("if (action === 'quote')"), apps.indexOf("if (action === 'set_code')"));
  check('Q1: the signup quote prices the extra fobs', /fob_extra/.test(quote));
  check('Q1: submit stores the extra fobs', /fob_extra_count:/.test(apps.slice(apps.indexOf("if (action === 'submit')"), apps.indexOf("if (action === 'quote')"))));

  const apply = read('apply.html');
  const step4 = apply.slice(apply.indexOf('data-step="4"'), apply.indexOf('<script', apply.indexOf('data-step="4"')));
  check('Q2: the keyfob box is on the payment page, with a quantity', /id="need_new_fob"/.test(step4) && /id="fob-qty"/.test(step4) && !/id="need_new_fob"/.test(apply.slice(0, apply.indexOf('data-step="4"'))));
  check('Q2: new families are told the first fob is free', /New members get/.test(apply));
  check('Q2: app unlock is mentioned only when the club has it', /features\?\.gate/.test(apply) && /unlock the gate from the app/i.test(apply));
  check('Q2: the quote and submit send the quantity', (apply.match(/fob_extra/g) || []).length >= 2);

  const renew = read('m/renew.html');
  check('Q3: the renewal page has the quantity box', /id="fob-qty"/.test(renew) && /fob_extra/.test(renew));
  const ma = read('supabase/functions/member_auth/index.ts');
  check('Q3: renewal options and renew_start take the quantity', /fob_extra/.test(ma.slice(ma.indexOf("action === 'renewal_options'"), ma.indexOf("action === 'renewal_options'") + 6000)) && /fob_extra/.test(ma.slice(ma.indexOf("action === 'renew_start'"), ma.indexOf("action === 'list_my_parties'"))));

  const approve = apps.slice(apps.indexOf("if (action === 'approve')"), apps.indexOf("if (action === 'verify_payment')"));
  check('Q4: one helper sets up fobs at approval, for renewals and new families', (approve.match(/fobsAtApproval\(/g) || []).length === 2
    && approve.indexOf('fobsAtApproval(') < approve.indexOf("kind: 'renewal_approved'"));
  const kh = read('supabase/functions/_shared/keyfobs.ts');
  check('Q4: renewals never get the free one', /isNew/.test(kh) && /reason: 'new_member'/.test(kh));

  const home = read('m/index.html');
  check('Q5: the app can order several at once and pay once', /count/.test(read('supabase/functions/keyfobs/index.ts').slice(0, 99999)) && /keyfob_ids/.test(home));
  check('Q5: a broken fob goes to Member help', /Fob broken\?/.test(home));
  check('Q5: the board can swap a broken fob', /call\('swap'/.test(read('club/admin/keyfobs.html')) && /action === 'swap'/.test(read('supabase/functions/keyfobs/index.ts')));
}

console.log('X · keyfobs under Members, and canceling before payment (offline)');
{
  const sub = read('js/admin-subtabs.js');
  const members = sub.slice(sub.indexOf('members: ['), sub.indexOf('],', sub.indexOf('members: [')));
  const settingsStrip = sub.slice(sub.indexOf('settings: ['), sub.indexOf('],', sub.indexOf('settings: [')));
  check('X1: Keyfobs is under Members, not Settings', /keyfobs\.html/.test(members) && !/keyfobs\.html/.test(settingsStrip) && /'keyfobs\.html': 'members'/.test(sub));
  check('X1: the nav generator agrees', /"keyfobs\.html":\s+"members"/.test(read('scripts/rewrite_admin_nav.py')));
  check('X1: keyfob tasks count on the Members tab', /\^keyfob\\\.\|\^plan\\\.fob_\/\.test\(k\)\) return \{ sec: 'members', sub: 'keyfobs' \}/.test(read('js/admin-flags.js')));
  const k = await importTs(new URL('supabase/functions/_shared/keyfobs.ts', root));
  const f = (status, payment_status, included = false) => ({ status, payment_status, included });
  check('X2: an unpaid request can be canceled', k.canCancel?.(f('requested', 'unpaid')) === true);
  check('X2: so can a free one (nothing to pay)', k.canCancel?.(f('requested', 'none', true)) === true);
  check('X2: not once it\'s paid, by card, with the dues or a Venmo they sent', k.canCancel && !k.canCancel(f('requested', 'paid')) && !k.canCancel(f('requested', 'pending_verify')) && !k.canCancel(f('active', 'paid')));
  const kf = read('supabase/functions/keyfobs/index.ts');
  const memberPart = kf.slice(0, kf.indexOf('═══ The board'));
  const boardPart = kf.slice(kf.indexOf('═══ The board'));
  check('X2: the family can cancel, the board can cancel, both only before payment',
    /action === 'cancel'/.test(memberPart) && /action === 'cancel'/.test(boardPart) && /canCancel\(/.test(memberPart) && /canCancel\(/.test(boardPart));
  check('X2: canceling removes the request and closes its task', /\.delete\(\)/.test(kf.slice(kf.indexOf("action === 'cancel'"))) && /closeTasks\(/.test(boardPart.slice(boardPart.indexOf("action === 'cancel'"), boardPart.indexOf("action === 'cancel'") + 1500)));
  check('X2: a "Cancel request" on My family and on the board\'s Keyfobs page', /cancelFob\(/.test(read('m/index.html')) && /Cancel request/.test(read('m/index.html')) && /cancelRequest\(/.test(read('club/admin/keyfobs.html')));
  const wh = read('supabase/functions/stripe_webhook/index.ts');
  check('X2: a card payment for a canceled request becomes a refund task', /keyfob\.paid_after_cancel/.test(wh) && /household_id/.test(read('supabase/functions/stripe_checkout/index.ts').slice(read('supabase/functions/stripe_checkout/index.ts').indexOf("action === 'keyfob'"), read('supabase/functions/stripe_checkout/index.ts').indexOf("action === 'keyfob'") + 2500)));
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

    // X: cancel a request before it's paid, from either side (Doug, 10/9).
    {
      const gone = async id => (await sql(`select count(*)::int as n from keyfobs where id = '${id}'`))[0].n === 0;
      const r1 = await fn('keyfobs', { action: 'request' }, memTok);
      const c1 = await fn('keyfobs', { action: 'cancel', ids: [r1.fob?.id] }, memTok);
      check('X2: the family cancels an unpaid request', c1.ok && await gone(r1.fob?.id), short(c1));
      const r2 = await fn('keyfobs', { action: 'request' }, memTok);
      const c2 = await fn('keyfobs', { action: 'cancel', id: r2.fob?.id }, admTok);
      check('X2: the board cancels an unpaid request', c2.ok && await gone(r2.fob?.id), short(c2));
      const r3 = await fn('keyfobs', { action: 'request' }, memTok);
      await fn('keyfobs', { action: 'claim_venmo', ids: [r3.fob?.id] }, memTok);
      const c3m = await fn('keyfobs', { action: 'cancel', ids: [r3.fob?.id] }, memTok);
      const c3b = await fn('keyfobs', { action: 'cancel', id: r3.fob?.id }, admTok);
      check('X2: once they say they sent the Venmo, neither side can cancel', !c3m.ok && !c3b.ok && !(await gone(r3.fob?.id)), short({ c3m, c3b }));
      // The checkout was still open when they canceled, then they paid.
      const r4 = await fn('keyfobs', { action: 'request' }, memTok);
      const p4 = await fn('stripe_checkout', { action: 'keyfob', keyfob_id: r4.fob?.id }, memTok);
      const t4 = p4.url ? new URL(p4.url).hash.replace(/^#t=/, '') : '';
      await fn('keyfobs', { action: 'cancel', ids: [r4.fob?.id] }, memTok);
      await fn('stripe_checkout', { action: 'simulate_complete', token: t4 });
      const late = await sql(`select summary from admin_tasks where tenant_id = '${club.id}' and kind = 'keyfob.paid_after_cancel' and summary like '%${FAMILY}%' and completed_at is null`);
      check('X2: a card payment after canceling becomes a refund task for the board', late.length === 1 && /refund/i.test(late[0].summary), short(late));
      await sql(`delete from admin_tasks where tenant_id = '${club.id}' and kind = 'keyfob.paid_after_cancel' and summary like '%${FAMILY}%'`);
      const sid4 = t4 ? JSON.parse(Buffer.from(t4.split('.')[1], 'base64url').toString()).sid : null;
      if (sid4) await sql(`delete from stripe_processed_events where id = 'evt_${sid4}'`);
    }
    if (!ONLY) {

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
    // Q1: extra fobs at signup are priced with the membership, up to 5 in all.
    const q0 = await fn('applications', { action: 'quote', slug: 'bishopestates', need_new_fob: true });
    const q2 = await fn('applications', { action: 'quote', slug: 'bishopestates', need_new_fob: true, fob_extra: 2 });
    check('Q1: 2 extra fobs add $30 to the membership price', q2.ok && q2.price.fob_count === 2 && q2.price.fob_cents === 3000
      && q2.price.amount_due_cents === q0.price.amount_due_cents + 3000, short({ q0: q0.price?.amount_due_cents, q2: q2.price }));
    const q9 = await fn('applications', { action: 'quote', slug: 'bishopestates', need_new_fob: true, fob_extra: 9 });
    check('Q1: no more than 5 in all, counting the free one', q9.price?.fob_count === 4 && q9.price?.fob_room === 4, short(q9.price));

    // A new family's included fob and 2 extras, at approval, with one task.
    const app = await sql(`insert into applications (tenant_id, family_name, primary_name, primary_email, primary_phone, address, status, payment_status, payment_method, is_new_member, need_new_fob, fob_extra_count, membership_year)
      values ('${club.id}', '${FAMILY} New', 'New Tester', 'delivered@resend.dev', '+1555${String(Number(stamp) + 1).padStart(7, '0')}', '12 Brand New Ct', 'pending', 'paid', 'stripe', true, true, 2, 2027) returning id`);
    const ap = await fn('applications', { action: 'approve', id: app[0].id }, admTok);
    const nf = await sql(`select k.included, k.reason, k.status, k.payment_status, k.payment_method, k.household_id from keyfobs k join applications a on a.household_id = k.household_id where a.id = '${app[0].id}' order by k.included desc`);
    check('P2: a new family is approved with its included fob waiting to be issued', ap.ok && nf.length >= 1 && nf[0].included && nf[0].reason === 'new_member' && nf[0].payment_status === 'none', short({ ap: ap.ok, nf }));
    check('Q4: and the 2 extras it bought, paid with the dues', nf.length === 3 && nf.slice(1).every(f => f.reason === 'extra' && f.payment_status === 'paid' && f.payment_method === 'with_dues' && f.status === 'requested'), short(nf));
    const nt = nf.length ? await sql(`select summary from admin_tasks where source_kind = 'keyfob_household' and source_id = '${nf[0].household_id}' and completed_at is null`) : [];
    check('Q4: one task for the board: issue 3 keyfobs', nt.length === 1 && /3 keyfobs/.test(nt[0].summary), short(nt));

    // Q3: a renewing family's fobs count toward the 5; extras come with the renewal.
    const ro = await fn('member_auth', { action: 'renewal_options', fob_extra: 9 }, memTok);
    const [{ n: liveNow }] = await sql(`select count(*)::int as n from keyfobs where household_id = '${m.household_id}' and status in ('requested', 'active')`);
    check('Q3: the renewal page prices extras up to the limit', ro.ok && ro.price?.fob_count === 5 - liveNow && ro.keyfobs?.fee_cents === 1500, short({ liveNow, price: ro.price, k: ro.keyfobs }));
    const ren = await sql(`insert into applications (tenant_id, household_id, is_renewal, is_new_member, family_name, primary_name, status, payment_status, payment_method, fob_extra_count, membership_year)
      values ('${club.id}', '${m.household_id}', true, false, '${FAMILY}', 'Renew Tester', 'pending', 'paid', 'stripe', 1, 2027) returning id`);
    const rap = await fn('applications', { action: 'approve', id: ren[0].id }, admTok);
    const rf = await sql(`select reason, included, payment_method from keyfobs where household_id = '${m.household_id}' and payment_method = 'with_dues'`);
    check('Q4: a renewal\'s extra fob is set up, and no free one', rap.ok && rf.length === 1 && rf[0].reason === 'extra' && !rf[0].included, short({ rap, rf }));

    // Q5: several at once in the app, up to the limit, paid together.
    const [{ n: live2 }] = await sql(`select count(*)::int as n from keyfobs where household_id = '${m.household_id}' and status in ('requested', 'active')`);
    const many = await fn('keyfobs', { action: 'request', count: 5 - live2 }, memTok);
    const over = await fn('keyfobs', { action: 'request', count: 1 }, memTok);
    check('Q5: the app orders several at once, and no more than 5 in all', many.ok && many.fobs?.length === 5 - live2 && !over.ok && /most a family|per family/.test(over.error || ''), short({ live2, many: many.fobs?.length, over }));
    const ids = (many.fobs || []).map(f => f.id);
    const pay2 = await fn('stripe_checkout', { action: 'keyfob', keyfob_ids: ids }, memTok);
    const tok2 = pay2.url ? new URL(pay2.url).hash.replace(/^#t=/, '') : '';
    const amt2 = tok2 ? JSON.parse(Buffer.from(tok2.split('.')[1], 'base64url').toString()).amt : 0;
    await fn('stripe_checkout', { action: 'simulate_complete', token: tok2 });
    const pd = ids.length ? await sql(`select payment_status from keyfobs where id in (${ids.map(i => `'${i}'`).join(',')})`) : [];
    check('Q5: one card payment covers them all, card fee on the member', pay2.ok && amt2 === Math.ceil((1500 * ids.length + 30) / 0.971) && pd.length === ids.length && pd.every(r => r.payment_status === 'paid'), short({ amt2, pd }));

    // Q5: a broken fob: swapped free, or the fee first.
    const [act] = await sql(`select id from keyfobs where household_id = '${m.household_id}' and status = 'active' limit 1`);
    const fobC = fobB + 7;
    const sw = await fn('keyfobs', { action: 'swap', id: act.id, number: String(fobC) }, admTok);
    const [old] = await sql(`select status from keyfobs where id = '${act.id}'`);
    check('Q5: the board swaps a broken fob free: old off, new one on', sw.ok && old.status === 'off' && sw.fob?.status === 'active' && sw.fob?.price_cents === 0 && Number(sw.fob?.card_number) === fobC, short({ sw, old }));
    const sc = await fn('keyfobs', { action: 'swap', id: sw.fob?.id, charge: true }, admTok);
    const [chg] = await sql(`select status, payment_status, price_cents from keyfobs where replaces_id = '${sw.fob?.id}'`);
    check('Q5: or charges $15 for it', sc.ok && chg?.payment_status === 'unpaid' && chg?.price_cents === 1500, short({ sc, chg }));
    }
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

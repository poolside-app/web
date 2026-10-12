#!/usr/bin/env node
// Targeted check for telling the party person about every paid party
// (PLAN.md AE). Offline: reads the code and runs the message builders.
//
// `--live` books and pays (test card) a party for a temporary family on
// Bishop: the party person gets one real pop-up and email. Removed after.
//
// Usage: node scripts/test_party_booked.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const LIVE = process.argv.includes('--live');

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 300);

console.log('AE1 · the party person hears about every paid party (offline)');
let pb = null;
try { pb = await importTs(new URL('supabase/functions/_shared/party_booked.ts', root)); } catch (e) { check('the messages live in _shared/party_booked.ts', false, e.message); }
if (pb) {
  const party = { title: 'Brooks birthday', starts_at: '2027-06-20T21:00:00Z', ends_at: '2027-06-21T00:00:00Z', expected_guests: 25, price_cents: 25000 };
  const who = { name: 'Linda Brooks', phone_e164: '+15551234567', email: 'linda@example.com' };
  const s = pb.bookedSummary(party, 'Brooks Family', who, 'card', 'America/Los_Angeles');
  check('the to-do says the party, when, guests, how it was paid, and who to call', /Brooks birthday/.test(s) && /Jun 20/.test(s) && /2(:00)?\s?PM/.test(s) && /25 guests/.test(s) && /card/.test(s) && /Linda Brooks/.test(s) && /\(555\) 123-4567/.test(s), s);
  const v = pb.bookedSummary(party, 'Brooks Family', { name: 'Linda Brooks' }, 'venmo', 'America/Los_Angeles');
  check('without a phone it still names who to get in touch with', /Linda Brooks/.test(v) && /Venmo/.test(v) && !/undefined|null/.test(v), v);
  const html = pb.bookedEmailHtml(party, 'Brooks Family', who, 'card', 'America/Los_Angeles', 'https://bishopestates.poolsideapp.com');
  check('the email has tap-to-call, text and email for the family', /href="tel:\+15551234567"/.test(html) && /href="sms:\+15551234567"/.test(html) && /href="mailto:linda@example\.com"/.test(html) && /club\/admin\/parties\.html/.test(html));
  check('names and notes are escaped in the email', !/<script>/.test(pb.bookedEmailHtml({ ...party, title: '<script>x</script>' }, 'F', who, 'card', 'America/Los_Angeles', 'https://x')));
}
const pos = await importTs(new URL('supabase/functions/_shared/positions.ts', root));
check('it goes to the party person (the rentals alert)', pos.TASK_NOTICE['party.booked'] === 'rentals');
const wh = read('supabase/functions/stripe_webhook/index.ts');
check('paid by card: the webhook sends it', /partyBookedAlert\([^)]*'card'/.test(wh.slice(wh.indexOf("kind === 'party_booking'"))));
const pa = read('supabase/functions/parties_admin/index.ts');
check('a Venmo the board approves: sends it', /partyBookedAlert\(/.test(pa.slice(pa.indexOf("action === 'verify_payment'"), pa.indexOf("action === 'reject'"))));
const ma = read('supabase/functions/member_auth/index.ts');
check('free at an open time: sends it', /partyBookedAlert\([^)]*'free'/.test(ma));
const pbSrc = read('supabase/functions/_shared/party_booked.ts');
check('a to-do, a pop-up (from the task) and an email to whoever gets the rentals alert', /enqueueAdminTask\(/.test(pbSrc) && /push_title/.test(pbSrc) && /recipientsFor\([^)]*'rentals'\)/.test(pbSrc) && /sendEmail\(/.test(pbSrc));
check('the board home shows it as "Party booked"', /party\\\.booked/.test(read('club/admin/index.html')));

check('AF2: a party to-do opens that party', /link_url: `\/club\/admin\/parties\.html#p=\$\{p\.id\}`/.test(pbSrc) && /#p=/.test(read('club/admin/parties.html')) && /openModal\(/.test(read('club/admin/parties.html').slice(read('club/admin/parties.html').indexOf('#p='))));

console.log('AE2 · the family asks the board (offline)');
const et = read('supabase/functions/_shared/email_template.ts');
const conf = et.slice(et.indexOf("key: 'party_confirmed'"), et.indexOf("key: 'party_rejected'"));
check('"Your party is booked" points them to Ask the board → Parties & events', /Ask the board/.test(conf) && /Parties &amp; events|Parties & events/.test(conf));

console.log('AE3 · the Parties page (offline)');
const pp = read('club/admin/parties.html');
check('the family\'s phone and email are tap-to-call, text and email', /function contactLinks/.test(pp) && /`tel:\$\{tel\}`/.test(pp) && /`sms:\$\{tel\}`/.test(pp) && /`mailto:\$\{r\.email\}`/.test(pp) && /\$\{contactLinks\(b\.requester\)\}/.test(pp));

if (LIVE) {
  console.log('\nLive (Bishop, temporary family, test card)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-ae/1.0' },
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
  const FAMILY = `SimTest Party ${String(Date.now()).slice(-6)}`;
  let partyId = null, sid = null;
  try {
    const m = await makeTempMember(sql, club.id, FAMILY);
    await sql(`update households set paid_until_year = 2027 where id = '${m.household_id}'`);
    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, hid: m.household_id, slug: 'bishopestates' });
    // Two weeks out, 2 PM at the pool (21:00 UTC in daylight time).
    const day = new Date(Date.now() + 14 * 864e5); day.setUTCHours(21, 0, 0, 0);
    const req = await fn('member_auth', { action: 'request_party', title: `${FAMILY} birthday`, starts_at: day.toISOString(), expected_guests: 20, body: 'Test party (removed after)', policies_accepted: true, signature: 'SimTest' }, memTok);
    partyId = req.party?.id;
    check('a party is requested', req.ok && !!partyId, short(req));
    if (partyId && req.party?.status !== 'approved') {
      const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' order by created_at limit 1`);
      await fn('parties_admin', { action: 'approve', id: partyId }, jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' }));
    }
    const pay = await fn('stripe_checkout', { action: 'party_booking', party_id: partyId }, memTok);
    const tok = pay.url ? new URL(pay.url).hash.replace(/^#t=/, '') : '';
    sid = tok ? JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sid : null;
    await fn('stripe_checkout', { action: 'simulate_complete', token: tok });
    const [paid] = await sql(`select payment_status from party_bookings where id = '${partyId}'`);
    check('paid by (test) card', paid?.payment_status === 'paid', short({ pay, paid }));
    const t = await sql(`select summary, notice from admin_tasks where source_kind = 'party_booking' and source_id = '${partyId}' and kind = 'party.booked' and completed_at is null`);
    check('the party person has a "get in touch" to-do', t.length === 1 && /Get in touch with/.test(t[0].summary) && /paid by card/.test(t[0].summary), short(t));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    if (partyId) await sql(`delete from admin_tasks where source_kind = 'party_booking' and source_id = '${partyId}';
      delete from events where id in (select event_id from party_bookings where id = '${partyId}' and event_id is not null)`);
    if (sid) await sql(`delete from stripe_processed_events where id = 'evt_${sid}'`);
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    const [{ left }] = await sql(`select (select count(*) from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%') + (select count(*) from party_bookings where title like '${FAMILY}%') as left`);
    check('cleanup: the temporary family and party are gone', Number(left) === 0, String(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

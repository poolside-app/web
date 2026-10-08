#!/usr/bin/env node
// Targeted check for Doug's 10/7 signup-test notes (PLAN.md N1–N8).
// Offline checks read the pages and helpers and cost nothing. `--live` adds
// about 12 Edge Function calls on Bishop with a temporary family it removes.
//
// Usage: node scripts/test_signup_notes.mjs [--live]
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempMember, purgeTestFamilies } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const between = (src, from, to) => { const i = src.indexOf(from); return i < 0 ? '' : src.slice(i, to ? src.indexOf(to, i + from.length) : undefined); };
const LIVE = process.argv.includes('--live');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 240);

console.log('N1 · signup checks the phone and email on step 1 (offline)');
{
  const apply = read('apply.html');
  const apps = read('supabase/functions/applications/index.ts');
  check('step 1 asks the server before moving on', /return checkContactThenNext\(phone, email\)/.test(apply) && /action: 'check_contact'/.test(apply));
  check('"already a member" shows under the field, with Sign in', /already belongs to a member here/.test(apply) && /\/m\/login\.html/.test(between(apply, 'async function checkContactThenNext', 'function _goNext')));
  check('the server answers check_contact from members and waiting applications', /action === 'check_contact'/.test(apps) && /pendingApplications\(/.test(between(apps, "action === 'check_contact'", "action === 'submit'")));
  check('an unfinished card signup is replaced, not a dead end', /setAsideUnfinished\(sb, tenant\.id as string, pendingHits\.filter\(unfinishedCardSignup\)\)/.test(apps));
  check('a Venmo application still blocks a second one', /pendingHits\.filter\(a => !unfinishedCardSignup\(a\)\)/.test(apps));
  check('the canceled-payment page offers to start again', /start your application again/.test(apply));
}

console.log('N2 · the iPhone Home Screen app opens signed in (offline)');
{
  const home = read('m/index.html');
  const man = read('supabase/functions/tenant_manifest/index.ts');
  const auth = read('supabase/functions/member_auth/index.ts');
  check('the member home asks for a one-time sign-in on an iPhone', /callMember\('handoff'\)/.test(home) && /iPad\|iPhone\|iPod/.test(between(home, 'async function prepareHandoff', '\n}\n')));
  check('it goes into the app\'s start address', /manifest\.webmanifest\?h=/.test(home) && /\?h=\$\{opts\.handoff\}/.test(man) && /no-store/.test(man));
  check('the app signs in with it once, then drops it from the address', /get\('h'\)/.test(home) && /action: 'verify', slug: getSlug\(\), token: handoff/.test(home));
  check('a handoff is an ordinary one-time sign-in link, 7 days', /action === 'handoff'/.test(auth) && /7 \* 86400_000/.test(between(auth, "action === 'handoff'", 'return jsonResponse')));
  check('the install card uses the shared guide (Chrome on iPhone too)', /Pwa\.renderInstallGuide\(document\.getElementById\('install-guide'\)/.test(home));
}

console.log('N3 · parties: a start time and the club\'s length (offline)');
{
  const pl = await importTs(new URL('supabase/functions/_shared/party_length.ts', root));
  check('4 hours unless the board changes it', pl.partyHours({}) === 4 && pl.partyHours({ parties: { length_hours: 3 } }) === 3 && pl.partyHours({ parties: { length_hours: 99 } }) === 12);
  check('the end follows from the start', pl.partyEnd('2026-10-31T21:00:00.000Z', 4) === '2026-11-01T01:00:00.000Z');
  const home = read('m/index.html');
  const auth = read('supabase/functions/member_auth/index.ts');
  const admin = read('club/admin/parties.html');
  check('members pick a date and start time only', !/id="p-ends"/.test(home) && /Date and start time/.test(home) && /paintPartyEnd/.test(home));
  check('the server sets the end, ignoring any sent', /partyEnd\(startsDate\.toISOString\(\), ps\.hours\)/.test(auth));
  check('approving with a new start moves the whole party', !/ov-ends_at/.test(admin) && /newEnd = newStart \? partyEnd/.test(read('supabase/functions/parties_admin/index.ts')));
  check('the approve window fits a phone', /@media \(max-width: 640px\)[\s\S]*?\.row2 \{ grid-template-columns: 1fr; \}/.test(admin));
  check('the board sets the party length on the Parties page', /id="party-hours"/.test(admin) && /settings_save/.test(admin));
  check('party decisions pop up for the family', (read('supabase/functions/parties_admin/index.ts').match(/partyPop\(/g) || []).length >= 4);
}

console.log('N4–N7 · alerts, help, pop-ups, Text all members (offline)');
{
  const auth = read('supabase/functions/member_auth/index.ts');
  check('N4: a photo upload is a dashboard task with a pop-up', /enqueueAdminTask\(sb, \{\s*tenant_id: tid,\s*target_scopes: \['photos'\],\s*kind: 'photo\.pending_approval'/.test(auth));
  const help = read('supabase/functions/help_requests/index.ts');
  check('N5: board replies pop up, else email; never a text', !/sendSms/.test(help) && /pushMembers\(/.test(help) && /sent_by = 'popup'/.test(help));
  check('N5: a solved question is closed; a new one starts fresh', /This question is solved/.test(help) && /help-thread-solved/.test(read('m/index.html')));
  check('N5: removing a board member drops their positions', /board_position_holders'\)\.delete\(\)\.eq\('admin_user_id', id\)/.test(read('supabase/functions/tenant_admin_auth/index.ts')));
  check('N6: members can turn on notifications', /MemberPush\.mountPrompt/.test(read('m/index.html')) && /action === 'subscribe'/.test(read('supabase/functions/push_member/index.ts')));
  check('N6: announcements have a "Notify members" switch, on by default', /id="m-notify" checked/.test(read('club/admin/announcements.html')) && /notify_members !== false/.test(read('supabase/functions/posts_admin/index.ts')));
  check('N6: announcements pop up only (no email, no text)', !/sendEmail|sendSms/.test(between(read('supabase/functions/posts_admin/index.ts'), "action === 'create'", "action === 'update'")));
  check('N6: agendas reach the board by pop-up only', !/sendSms|sendEmail/.test(between(read('supabase/functions/board_meetings/index.ts'), "action === 'send_agenda'", "action === 'bylaws'")));
  check('N6: plan receipts and failures pop up too', /pushMembers/.test(between(read('supabase/functions/payment_plans/index.ts'), 'async function sendReceipt', '\n}\n')));
  check('N7: "Text all members" opens its window', /getElementById\('blast-scrim'\)\.classList\.add\('open'\)/.test(read('club/admin/announcements.html')));
  check('N7: board billing buttons verify the login (was calling a missing function)', !/verifyAdmin\(/.test(read('supabase/functions/tenant_admin_auth/index.ts')));
}

console.log('O · parties: open times, card first (offline)');
{
  const ps = await importTs(new URL('supabase/functions/_shared/party_slots.ts', root));
  const set = ps.partySettings({ parties: { fee_cents: 25000, auto_approve: true, hold_days: 2 } });
  check('Bishop: $250, open times approved on the spot, 2-day hold', set.fee_cents === 25000 && set.auto_approve && set.hold_days === 2 && set.hours === 4);
  check('the card fee is the member\'s: $250 → $257.78', ps.partyCardTotal(25000) === Math.ceil((25000 + 30) / 0.971) && ps.partyCardTotal(25000) === 25778, String(ps.partyCardTotal(25000)));
  check('two parties can share a day, not a time', ps.overlaps('2027-06-12T21:00:00Z', '2027-06-13T01:00:00Z', '2027-06-12T23:00:00Z', '2027-06-13T03:00:00Z') && !ps.overlaps('2027-06-12T21:00:00Z', '2027-06-13T01:00:00Z', '2027-06-13T01:00:00Z', '2027-06-13T05:00:00Z'));
  const now = Date.parse('2027-06-01T12:00:00Z');
  check('an unpaid approved party holds its time for 2 days', ps.holdsTime({ status: 'approved', payment_status: 'unpaid', decided_at: '2027-05-31T00:00:00Z' }, 2, now) && !ps.holdsTime({ status: 'approved', payment_status: 'unpaid', decided_at: '2027-05-29T00:00:00Z' }, 2, now));
  check('a Venmo they say they sent holds it until the board confirms', ps.holdsTime({ status: 'approved', payment_status: 'pending_verify', decided_at: '2027-05-01T00:00:00Z' }, 2, now));
  const home = read('m/index.html');
  check('members pay by card first, Venmo second', /payPartyCard\('\$\{b\.id\}'\)/.test(home) && /I paid \$\{b\.price_cents \? usd\(b\.price_cents\)/.test(home));
  check('the request form shows times already taken that day', /callMember\('party_busy'/.test(home));
  check('the board edits the fee and automatic approval', /id="party-fee"/.test(read('club/admin/parties.html')) && /id="party-auto"/.test(read('club/admin/parties.html')));
  check('a party card payment carries the card fee', /partyCardTotal\(feeCents/.test(read('supabase/functions/stripe_checkout/index.ts')));
  check('the daily run gives back unpaid times after the hold', /parties_released/.test(read('supabase/functions/payment_plans/index.ts')));
}

if (LIVE) {
  console.log('\nLive (Bishop, temporary family)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-notes/1.0' },
      body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const b64 = b => Buffer.from(b).toString('base64url');
  const jwt = p => { const h = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' })); const body = b64(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 600 })); return `${h}.${body}.${createHmac('sha256', env.ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`; };
  const fn = async (name, body, token, headers = {}) => {
    const r = await fetch(`${env.SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json().catch(() => ({}))) };
  };
  const [club] = await sql(`select id from tenants where slug = 'bishopestates'`);
  const FAMILY = `SimTest Notes ${String(Date.now()).slice(-6)}`;
  try {
    const m = await makeTempMember(sql, club.id, FAMILY);
    const testPhone = '+1555' + String(Date.now()).slice(-7);
    await sql(`update household_members set phone_e164 = '${testPhone}' where id = '${m.id}'`);
    const mm = { phone_e164: testPhone };
    const c1 = await fn('applications', { action: 'check_contact', slug: 'bishopestates', phone: mm.phone_e164, email: 'nobody-' + Date.now() + '@example.com' });
    check('N1: a member\'s phone on step 1 says "already a member"', c1.ok && c1.member && c1.matched_via === 'phone', short(c1));
    const c2 = await fn('applications', { action: 'check_contact', slug: 'bishopestates', phone: '(555) 010-' + String(Date.now()).slice(-4), email: 'new-' + Date.now() + '@example.com' });
    check('N1: a new family goes straight on', c2.ok && !c2.member && !c2.applied, short(c2));

    const memTok = jwt({ sub: m.id, kind: 'member', tid: club.id, hid: m.household_id, slug: 'bishopestates' });
    const [owner] = await sql(`select id from admin_users where tenant_id = '${club.id}' and active and role_template = 'owner' limit 1`);
    const admTok = jwt({ sub: owner.id, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    const h = await fn('member_auth', { action: 'handoff' }, memTok);
    check('N2: the member home gets a one-time sign-in', h.ok && /^[A-Za-z0-9_-]{40,}$/.test(h.token || ''), short(h));
    const man = await fetch(`${env.SUPABASE_URL}/functions/v1/tenant_manifest?slug=bishopestates&h=${h.token}`);
    const mj = await man.json();
    check('N2: the Home Screen app starts with it, never cached', mj.start_url === `/m/?h=${h.token}` && /no-store/.test(man.headers.get('cache-control') || ''), short({ start: mj.start_url, cache: man.headers.get('cache-control') }));
    const v = await fn('member_auth', { action: 'verify', slug: 'bishopestates', token: h.token });
    check('N2: the app signs in with it', v.ok && !!v.token, short(v));
    const v2 = await fn('member_auth', { action: 'verify', slug: 'bishopestates', token: h.token });
    check('N2: and only once', !v2.ok, short(v2));

    const sub = await fn('push_member', { action: 'subscribe', endpoint: 'https://example.com/push/' + Date.now(), p256dh: 'x'.repeat(20), auth: 'y'.repeat(10) }, memTok);
    const [{ n }] = await sql(`select count(*)::int n from member_push_subscriptions where member_id = '${m.id}'`);
    check('N6: a member can turn on notifications', sub.ok && n === 1, short(sub));

    const ps = await fn('parties_admin', { action: 'settings_get' }, admTok);
    check('N3/O: the Parties page reads the length, fee and automatic approval', ps.ok && ps.length_hours === 4 && ps.fee_cents === 25000 && ps.auto_approve === true, short(ps));

    // O: parties
    const day = '2027-06-12';
    const at = h => new Date(`${day}T${String(h).padStart(2, '0')}:00:00-07:00`).toISOString();
    const req = (h, title) => fn('member_auth', { action: 'request_party', title, starts_at: at(h), policies_accepted: true }, memTok);
    const b0 = await fn('member_auth', { action: 'party_busy', date: day }, memTok);
    check('O: an empty day shows nothing taken', b0.ok && b0.busy.length === 0, short(b0));
    const p1 = await req(14, `${FAMILY} party A`);
    check('O: an open time is approved on the spot, $250, card $257.78', p1.ok && p1.approved && p1.fee_cents === 25000 && p1.card_total_cents === 25778, short(p1));
    const clash = await req(16, `${FAMILY} party B`);
    check('O: a time overlapping it is refused, with the taken time', !clash.ok && clash.status === 409 && /overlaps/.test(clash.error || ''), short(clash));
    const p2 = await req(19, `${FAMILY} party C`);
    check('O: a later time the same day is fine', p2.ok && p2.approved, short(p2));
    const b1 = await fn('member_auth', { action: 'party_busy', date: day }, memTok);
    check('O: the form shows both times taken', b1.ok && b1.busy.length === 2, short(b1));
    const pay = await fn('stripe_checkout', { action: 'party_booking', party_id: p1.party.id }, memTok);
    const tok = pay.url ? new URL(pay.url).hash.replace(/^#t=/, '') : '';
    const amt = tok ? JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).amt : 0;
    check('O: card checkout charges $257.78 (fee + card fee)', pay.ok && amt === 25778, short({ pay, amt }));
    await fn('stripe_checkout', { action: 'simulate_complete', token: tok });
    const [booked] = await sql(`select status, payment_status, event_id from party_bookings where id = '${p1.party.id}'`);
    check('O: paying by card books it and puts it on the calendar', booked.status === 'approved' && booked.payment_status === 'paid' && !!booked.event_id, short(booked));
    await sql(`update party_bookings set decided_at = now() - interval '3 days' where id = '${p2.party.id}'`);
    const cron = await fn('payment_plans', { action: 'cron_run' }, null, { 'x-cron-secret': env.CRON_SECRET });
    const [released] = await sql(`select status from party_bookings where id = '${p2.party.id}'`);
    check('O: an unpaid party gives its time back after 2 days', cron.ok && cron.parties_released >= 1 && released.status === 'cancelled', short({ released, n: cron.parties_released }));
    const p3 = await req(19, `${FAMILY} party D`);
    check('O: and that time can be booked again', p3.ok && p3.approved, short(p3));
    const vc = await fn('member_auth', { action: 'claim_party_paid', id: p3.party.id }, memTok);
    const [pv] = await sql(`select payment_status from party_bookings where id = '${p3.party.id}'`);
    check('O: Venmo still works and waits for the board', vc.ok && pv.payment_status === 'pending_verify', short(pv));
    const ver = await fn('parties_admin', { action: 'verify_payment', id: p3.party.id }, admTok);
    const [pd] = await sql(`select payment_status, event_id from party_bookings where id = '${p3.party.id}'`);
    check('O: the board confirms the Venmo and it\'s booked', ver.ok && pd.payment_status === 'paid' && !!pd.event_id, short({ ver, pd }));
  } catch (e) {
    check('live run', false, e.message);
  } finally {
    await sql(`delete from events where id in (select event_id from party_bookings where tenant_id = '${club.id}' and title like '${FAMILY}%' and event_id is not null);
      delete from admin_tasks where source_kind = 'party_booking' and source_id in (select id from party_bookings where tenant_id = '${club.id}' and title like '${FAMILY}%');
      delete from stripe_processed_events where id in (select 'evt_' || stripe_session_id from party_bookings where tenant_id = '${club.id}' and title like '${FAMILY}%' and stripe_session_id is not null)`);
    await purgeTestFamilies(sql, club.id, `${FAMILY}%`);
    const [{ left }] = await sql(`select count(*)::int left from households where tenant_id = '${club.id}' and family_name like '${FAMILY}%'`);
    check('cleanup: the temporary family is gone', left === 0);
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

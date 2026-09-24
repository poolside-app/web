#!/usr/bin/env node
// Every time in the app follows the pool's own time zone (PLAN.md A3).
// Mostly offline. About 15 Edge Function calls: a handful of live endpoint
// checks, one calendar re-sync, and two real pages opened in headless Chrome
// with its clock set to New York, where Bishop (Pacific) times must still
// read as Pacific.
//
// Usage: node scripts/test_pool_time.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

const ROOT = new URL('..', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(join(ROOT, '.env.local'), 'utf8')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, ADMIN_JWT_SECRET, CRON_SECRET } = env;
const LA = 'America/Los_Angeles';
const SLUG = 'bishopestates';

let passed = 0, failed = 0, calls = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + String(detail).slice(0, 220) : ''}`); }
  return ok;
}
async function attempt(label, fn) {
  try { return await fn(); } catch (e) { check(label, false, e.message.split('\n')[0]); return undefined; }
}
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-pooltime/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}
async function fn(name, body, token, headers = {}) {
  calls++;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json().catch(() => ({}))) };
}
const b64url = b => Buffer.from(b).toString('base64url');
function jwt(p) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + 900 }));
  return `${h}.${body}.${createHmac('sha256', ADMIN_JWT_SECRET).update(`${h}.${body}`).digest('base64url')}`;
}
// web/package.json says "commonjs", so a plain import() of a .ts file fails.
// Files are concatenated in order with their relative imports dropped, so a
// module and the _shared helpers it imports load as one.
async function importTs(...rels) {
  let src = '';
  for (const rel of rels) {
    const path = join(ROOT, rel);
    if (!existsSync(path)) throw new Error(`${rel} does not exist`);
    src += readFileSync(path, 'utf8').replace(/^import .* from '\.\/[^']+';$/gm, '') + '\n';
  }
  const js = stripTypeScriptTypes(src, { mode: 'strip' });
  return import('data:text/javascript,' + encodeURIComponent(js));
}
const q = s => `'${String(s).replace(/'/g, "''")}'`;

const [tenant] = await sql(`select id from tenants where slug = ${q(SLUG)}`);
const [member] = await sql(`select m.id, m.household_id from household_members m join households h on h.id = m.household_id
  where h.tenant_id = ${q(tenant.id)} and h.family_name like 'SimTest%' and m.role = 'primary' and m.active
  order by h.created_at limit 1`);
const memberToken = jwt({ sub: member.id, kind: 'member', tid: tenant.id, slug: SLUG, hid: member.household_id });
const adminToken = jwt({ sub: '00000000-0000-0000-0000-000000000000', kind: 'tenant_admin', tid: tenant.id, slug: SLUG,
  synthetic: true, impersonated_by: '00000000-0000-0000-0000-000000000000' });

// ── A3.1 ────────────────────────────────────────────────────────────────
console.log('A3.1  Each club has its own time zone');
await attempt('tenants.timezone exists', async () => {
  const [t] = await sql(`select timezone from tenants where id = ${q(tenant.id)}`);
  check('Bishop is Pacific', t.timezone === LA, `timezone=${t.timezone}`);
});
await attempt('database refuses a made-up zone', async () => {
  let refused = false;
  try { await sql(`begin; update tenants set timezone = 'Not/AZone' where id = ${q(tenant.id)}; rollback;`); }
  catch (e) { refused = /not recognized/i.test(e.message); }
  check('database refuses a made-up zone', refused);
});
const pub = await fn('tenant_public', { slug: SLUG });
check('public page gets the zone', pub.tenant?.timezone === LA, `tenant.timezone=${pub.tenant?.timezone}`);
const me = await fn('member_auth', { action: 'me' }, memberToken);
check('member app gets the zone', me.tenant?.timezone === LA, `tenant.timezone=${me.tenant?.timezone}`);
const adm = await fn('tenant_admin_auth', { action: 'me' }, adminToken);
check('admin pages get the zone', adm.tenant?.timezone === LA, `tenant.timezone=${adm.tenant?.timezone}`);
const bad = await fn('tenant_settings', { action: 'save', value: {}, timezone: 'Not/AZone' }, adminToken);
check('Settings refuses a made-up zone', bad.status === 400, JSON.stringify(bad));
const good = await fn('tenant_settings', { action: 'save', value: {}, timezone: LA }, adminToken);
check('Settings saves a real zone', good.ok === true, JSON.stringify(good));

// ── A3.2 ────────────────────────────────────────────────────────────────
console.log('\nA3.2  Server uses pool time');
await attempt('_shared/pool_time.ts loads', async () => {
  const pt = await importTs('supabase/functions/_shared/pool_time.ts');
  check('6 PM Pacific July 12 is July 12 at the pool', pt.poolDate('2026-07-13T01:00:00Z', LA) === '2026-07-12');
  const w = pt.partyWhen('2026-07-12T21:00:00Z', LA);
  check('party email says Sunday, July 12, 2026 at 2:00 PM',
    w.party_date === 'Sunday, July 12, 2026' && w.party_time === '2:00 PM', JSON.stringify(w));
  check('6 PM Pacific in summer is 01:00 UTC next day',
    pt.wallTimeToUtc(2026, 7, 12, 18, 0, 0, LA).toISOString() === '2026-07-13T01:00:00.000Z');
  check('6 PM Pacific in winter is 02:00 UTC next day',
    pt.wallTimeToUtc(2026, 12, 5, 18, 0, 0, LA).toISOString() === '2026-12-06T02:00:00.000Z');
  check('6 PM Central in summer is 23:00 UTC',
    pt.wallTimeToUtc(2026, 7, 12, 18, 0, 0, 'America/Chicago').toISOString() === '2026-07-12T23:00:00.000Z');
  check('7 PM Pacific on Sep 23 is still Sep 23 at the pool',
    pt.poolToday(LA, new Date('2026-09-24T02:00:00Z')) === '2026-09-23');
  const b = pt.poolDayBounds('2026-07-13T01:00:00Z', LA);
  check('pool day July 12 runs 07:00 UTC to 07:00 UTC',
    b.key === '2026-07-12' && b.startIso === '2026-07-12T07:00:00.000Z' && b.endIso === '2026-07-13T07:00:00.000Z', JSON.stringify(b));
});
await attempt('parties carry a pool date', async () => {
  try {
    const rows = await sql(`insert into party_bookings (tenant_id, household_id, title, starts_at, status, payment_status)
      values (${q(tenant.id)}, ${q(member.household_id)}, 'tz-test stamp', '2026-07-13T01:00:00Z', 'cancelled', 'unpaid')
      returning pool_date::text as pool_date`);
    check('a 6 PM Pacific party is stamped with that pool day', rows[0]?.pool_date === '2026-07-12', JSON.stringify(rows));
  } finally { await sql(`delete from party_bookings where title like 'tz-test%'`); }
});
await attempt('one party per pool day', async () => {
  let blocked = false, msg = '';
  try {
    await sql(`begin;
      insert into party_bookings (tenant_id, household_id, title, starts_at, status, payment_status)
        values (${q(tenant.id)}, ${q(member.household_id)}, 'tz-test morning', '2026-07-12T18:00:00Z', 'approved', 'paid');
      insert into party_bookings (tenant_id, household_id, title, starts_at, status, payment_status)
        values (${q(tenant.id)}, ${q(member.household_id)}, 'tz-test evening', '2026-07-13T01:00:00Z', 'approved', 'paid');
      rollback;`);
  } catch (e) { msg = e.message; blocked = /duplicate key|unique/i.test(e.message); }
  finally { await sql(`delete from party_bookings where title like 'tz-test%'`); }
  check('two paid parties on the same pool day are refused (11 AM and 6 PM Pacific)', blocked, msg);
});

// ── A3.3 ────────────────────────────────────────────────────────────────
console.log('\nA3.3  Calendar sync reads Google\'s time zone');
await attempt('_shared/ical.ts loads', async () => {
  const { parseIcal } = await importTs('supabase/functions/_shared/pool_time.ts', 'supabase/functions/_shared/ical.ts');
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT', 'UID:fri', 'SUMMARY:Friday swim',
    'DTSTART;TZID=America/Los_Angeles:20260710T180000', 'DTEND;TZID=America/Los_Angeles:20260710T200000',
    'RRULE:FREQ=WEEKLY;BYDAY=FR;COUNT=3', 'EXDATE;TZID=America/Los_Angeles:20260717T180000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:dst', 'SUMMARY:Across DST',
    'DTSTART;TZID=America/Los_Angeles:20261030T180000', 'RRULE:FREQ=WEEKLY;COUNT=2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:float', 'SUMMARY:Floating', 'DTSTART:20260715T090000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:utc', 'SUMMARY:UTC', 'DTSTART:20260715T160000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:allday', 'SUMMARY:All day', 'DTSTART;VALUE=DATE:20260716', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const evs = parseIcal(ics, new Date('2026-07-01T00:00:00Z'), new Date('2026-12-31T00:00:00Z'), LA);
  const starts = uid => evs.filter(e => e.uid === uid || e.uid.startsWith(uid)).map(e => e.starts_at).sort();
  check('Friday 6 PM Pacific weekly lands on Fridays (Jul 10, Jul 24; Jul 17 excluded)',
    JSON.stringify(starts('fri')) === JSON.stringify(['2026-07-11T01:00:00.000Z', '2026-07-25T01:00:00.000Z']), JSON.stringify(starts('fri')));
  check('a weekly 6 PM event stays 6 PM across the November clock change',
    JSON.stringify(starts('dst')) === JSON.stringify(['2026-10-31T01:00:00.000Z', '2026-11-07T02:00:00.000Z']), JSON.stringify(starts('dst')));
  check('a time with no zone is read as pool time', starts('float')[0] === '2026-07-15T16:00:00.000Z', starts('float')[0]);
  check('a UTC time stays UTC', starts('utc')[0] === '2026-07-15T16:00:00.000Z', starts('utc')[0]);
  const ad = evs.find(e => e.uid === 'allday');
  check('an all-day event stays all-day on its date', ad?.all_day === true && ad.starts_at.startsWith('2026-07-16'), JSON.stringify(ad));
});
await attempt('Bishop\'s real feed matches Google after a re-sync', async () => {
  const [feed] = await sql(`select id, ical_url from external_calendar_feeds where tenant_id = ${q(tenant.id)} and enabled limit 1`);
  const text = await (await fetch(feed.ical_url)).text();
  const block = text.replace(/\r\n[ \t]/g, '').split('BEGIN:VEVENT').slice(1)
    .find(b => /DTSTART;TZID=/.test(b) && !/RRULE/.test(b) && /SUMMARY:/.test(b));
  if (!block) { console.log('  (feed has no single timed event with a TZID — skipped)'); return; }
  const [, tzid, wall] = block.match(/DTSTART;TZID=([^:;\r\n]+):(\d{8}T\d{6})/);
  const summary = block.match(/SUMMARY:(.*)/)[1].trim();
  const pt = await importTs('supabase/functions/_shared/pool_time.ts');
  const expected = pt.wallTimeToUtc(+wall.slice(0, 4), +wall.slice(4, 6), +wall.slice(6, 8),
    +wall.slice(9, 11), +wall.slice(11, 13), +wall.slice(13, 15), tzid).toISOString();
  const r = await fn('external_calendar', { action: 'cron_sync_all' }, null, { 'x-cron-secret': CRON_SECRET });
  check('re-sync ran', r.ok === true, JSON.stringify(r));
  const [row] = await sql(`select e->>'starts_at' as starts_at from external_calendar_feeds f,
    jsonb_array_elements(f.cached_events) e where f.id = ${q(feed.id)} and e->>'summary' = ${q(summary)}
    and e->>'starts_at' = ${q(expected)} limit 1`);
  check(`"${summary}" (${wall} ${tzid}) is stored as ${expected}`, !!row, 'not found at the expected time');
});

// ── A3.4 + A3.5 ─────────────────────────────────────────────────────────
console.log('\nA3.4/A3.5  Screens show pool time, even on a phone set to New York');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^\/+/, '');
  const f = join(ROOT, p || 'index.html');
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
}).listen(8766, '127.0.0.1');
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true, args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  await page.emulateTimezone('America/New_York');
  await page.setContent(`<html><body><div id="today"></div><div id="cal"></div>
    <script src="http://127.0.0.1:8766/js/pooltime.js"></script>
    <script src="http://127.0.0.1:8766/js/today.js"></script>
    <script src="http://127.0.0.1:8766/js/calendar.js"></script></body></html>`, { waitUntil: 'load' });
  const r = await page.evaluate(() => {
    if (!window.PoolTime) return { missing: true };
    PoolTime.setZone('America/Los_Angeles');
    const d = new Date('2026-07-13T01:00:00Z');
    const out = {
      time: d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(/\u202f/g, ' '),
      date: d.toLocaleDateString('en-US'),
      dayKey: PoolTime.dayKey(d),
      toInput: PoolTime.toInput('2026-07-13T01:00:00Z'),
      fromInput: PoolTime.fromInput('2026-07-12T18:00'),
      winterInput: PoolTime.fromInput('2026-12-05T18:00'),
    };
    const k = PoolTime.todayKey(); const [y, m, dd] = k.split('-').map(Number);
    const open = { id: 'o', kind: 'event', external: true, title: 'Pool Open',
      starts_at: PoolTime.fromWall(y, m, dd, 7, 0).toISOString(), ends_at: PoolTime.fromWall(y, m, dd, 20, 0).toISOString() };
    PoolsideToday.render({ rootEl: document.getElementById('today'), events: [open],
      publicSettings: { pool: { opens_at: '08:00', closes_at: '20:00' } } });
    out.todayHtml = document.getElementById('today').innerHTML;
    const late = { id: 'late', kind: 'social', title: 'Late swim',
      starts_at: PoolTime.fromWall(y, m, dd, 23, 30).toISOString(), recurrence: 'weekly' };
    PoolsideCalendar.render({ rootEl: document.getElementById('cal'), events: [late] });
    const cell = key => document.querySelector(`#cal .pcal-day[data-day="${key}"] [data-id="late"]`);
    out.lateToday = !!cell(k);
    out.lateNextWeek = !!cell(PoolTime.addDays(k, 7)) || PoolTime.addDays(k, 7).slice(0, 7) !== k.slice(0, 7);
    out.todayCell = document.querySelector('#cal .pcal-today-cell')?.dataset.day === k;
    return out;
  });
  if (r.missing) check('js/pooltime.js loads', false, 'PoolTime is not defined');
  else {
    check('a 6 PM Pacific time reads "6:00 PM", not 9:00 PM', r.time === '6:00 PM', r.time);
    check('…and on July 12, not July 13', r.date === '7/12/2026' && r.dayKey === '2026-07-12', `${r.date} ${r.dayKey}`);
    check('an edit box shows 6:00 PM Pacific as 18:00', r.toInput === '2026-07-12T18:00', r.toInput);
    check('typing 18:00 saves 6 PM Pacific (summer)', r.fromInput === '2026-07-13T01:00:00.000Z', r.fromInput);
    check('typing 18:00 saves 6 PM Pacific (winter)', r.winterInput === '2026-12-06T02:00:00.000Z', r.winterInput);
    check('Today block shows Pool Open 7:00 AM – 8:00 PM', /7:00\s?AM – 8:00\s?PM/.test(r.todayHtml), r.todayHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200));
    check('an 11:30 PM Pacific event sits on its own day in the calendar', r.lateToday);
    check('…and repeats on the same weekday', r.lateNextWeek);
    check('the calendar highlights the pool\'s today', r.todayCell);
  }

  // Real pages, real data, New York clock.
  const live = await browser.newPage();
  await live.emulateTimezone('America/New_York');
  await live.evaluateOnNewDocument((tok) => { localStorage.setItem('poolside_member_token', tok); }, memberToken);
  calls += 6;
  await live.goto(`https://${SLUG}.poolsideapp.com/m/?pooltime-test=1`, { waitUntil: 'networkidle2', timeout: 45000 });
  const text = await live.evaluate(() => document.body.innerText);
  const openLine = (text.match(/Pool Open[\s\S]{0,40}/) || [''])[0].replace(/\s+/g, ' ');
  check('member home shows Pool Open at 7:00 AM Pacific on a New York phone',
    !/Pool Open/.test(text) || /7:00\s?AM/.test(openLine), openLine || '(no Pool Open today)');
} finally {
  await browser.close();
  server.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed · ~${calls} Edge Function calls`);
process.exit(failed ? 1 : 0);

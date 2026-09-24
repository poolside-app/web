#!/usr/bin/env node
// Targeted check of test payments (fake card + fake Venmo) against production.
// Costs about 15 Edge Function calls a run — never run the full suites for this.
//
// Creates two applications on bishopestates named "SimTest …" and leaves them
// in place: Doug deletes test data himself once testing is over. Welcome
// emails go to doug.frevele+simtest…@gmail.com; the 555 phone numbers are
// deliberately undeliverable, so a text is attempted and logged but never sent.
//
// Usage: node scripts/test_payments.mjs
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
  .split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l))
  .map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF } = env;
if (!SUPABASE_URL || !SUPABASE_ACCESS_TOKEN || !SUPABASE_PROJECT_REF) {
  console.error('Missing SUPABASE_URL / SUPABASE_ACCESS_TOKEN / SUPABASE_PROJECT_REF in .env.local');
  process.exit(2);
}

const SLUG = 'bishopestates';
const STAMP = String(Date.now()).slice(-6);
let calls = 0, passed = 0, failed = 0;

async function fn(name, body) {
  calls++;
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text();
  try { return { status: r.status, ...JSON.parse(text) }; } catch { return { status: r.status, raw: text.slice(0, 200) }; }
}
async function sql(query) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-payments/1.0' },
    body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`SQL ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const q = s => `'${String(s).replace(/'/g, "''")}'`;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
async function waitFor(query, pred, secs = 25) {
  for (let i = 0; i < secs; i++) {
    const rows = await sql(query);
    if (pred(rows)) return rows;
    await new Promise(r => setTimeout(r, 1000));
  }
  return sql(query);
}

function application(kind, method) {
  const n = kind === 'card' ? '1' : '2';
  const email = `doug.frevele+simtest-${kind}-${STAMP}@gmail.com`;
  const phone = `555${STAMP}${n}`;
  return {
    action: 'submit', slug: SLUG,
    family_name: `SimTest ${kind === 'card' ? 'Card' : 'Venmo'} ${STAMP}`,
    primary_name: `Sim ${kind === 'card' ? 'Card' : 'Venmo'} Tester`,
    primary_email: email, primary_phone: phone,
    address: '1 Test Lane', city: 'Testville', zip: '00000',
    adults: [{ name: `Sim ${kind === 'card' ? 'Card' : 'Venmo'} Tester`, email, phone }],
    children: [],
    waivers_accepted: { rules: true, guest: true, party: true, sitter: true, waiver: true },
    tier_slug: 'family', payment_method: method,
  };
}

async function appState(id) {
  const [a] = await sql(`select a.status, a.payment_status, a.payment_method, a.stripe_session_id,
      a.household_id, a.membership_year, a.paid_at, a.primary_phone,
      h.dues_paid_for_year, h.paid_until_year
    from applications a left join households h on h.id = a.household_id where a.id = ${q(id)}`);
  return a;
}

async function assertMember(id, method, label) {
  const a = (await waitFor(`select status, household_id from applications where id = ${q(id)}`,
    rows => rows[0]?.status === 'approved' && rows[0]?.household_id))[0];
  const s = await appState(id);
  check(`${label}: application approved`, s?.status === 'approved', `status=${s?.status}`);
  check(`${label}: payment marked paid via ${method}`, s?.payment_status === 'paid' && s?.payment_method === method,
    `payment_status=${s?.payment_status} method=${s?.payment_method}`);
  check(`${label}: household created and paid for ${s?.membership_year}`,
    !!s?.household_id && s?.dues_paid_for_year === true && s?.paid_until_year === s?.membership_year,
    `household=${s?.household_id} dues=${s?.dues_paid_for_year} until=${s?.paid_until_year}`);
  const actions = await sql(`select kind, body from application_actions where application_id = ${q(id)}`);
  const welcome = actions.find(x => x.kind === 'welcome_sent');
  check(`${label}: welcome email sent`, !!welcome && /email via Resend/.test(welcome.body || ''), `welcome=${JSON.stringify(welcome)}`);
  const texts = await sql(`select success, error from sms_log where to_phone = ${q(s?.primary_phone)} and source = 'applications.approve'`);
  check(`${label}: welcome text attempted`, texts.length > 0, 'no sms_log row');
  const signin = await fn('applications', { action: 'post_payment_signin', id });
  check(`${label}: sign-in link issued`, signin.ok && /\/m\/verify\.html#token=/.test(signin.verify_url || ''),
    JSON.stringify(signin).slice(0, 160));
  return s;
}

console.log(`Test payments on ${SLUG} — run ${STAMP}\n`);

const [tenant] = await sql(`select id from tenants where slug = ${q(SLUG)}`);
await sql(`update settings set value = jsonb_set(coalesce(value, '{}'::jsonb), '{payments,test_mode}', 'true'::jsonb, true)
  where tenant_id = ${q(tenant.id)}`);
console.log('Test mode switched on.\n');

// ── Card ────────────────────────────────────────────────────────────────
console.log('Card (fake Stripe checkout)');
const card = await fn('applications', application('card', 'stripe'));
if (check('card: application submitted', card.ok && card.application_id, JSON.stringify(card).slice(0, 160))) {
  const co = await fn('stripe_checkout', { action: 'application', application_id: card.application_id });
  const token = /\/pay-test\.html#t=([^&\s]+)/.exec(co.url || '')?.[1];
  if (check('card: checkout opens the fake payment page', co.ok && !!token, JSON.stringify(co).slice(0, 160))) {
    const done = await fn('stripe_checkout', { action: 'simulate_complete', token });
    check('card: simulated payment accepted', done.ok && /apply\.html\?paid=1/.test(done.redirect || ''), JSON.stringify(done).slice(0, 160));
    const s = await assertMember(card.application_id, 'stripe', 'card');
    check('card: marked as a simulated session (sim_…)', /^sim_cs_/.test(s?.stripe_session_id || ''), `session=${s?.stripe_session_id}`);
    const again = await fn('stripe_checkout', { action: 'simulate_complete', token });
    const [{ n }] = await sql(`select count(*)::int as n from households where tenant_id = ${q(tenant.id)} and family_name like ${q(`SimTest Card ${STAMP}%`)}`);
    check('card: paying twice does not create a second household', again.ok && n === 1, `households=${n}`);
  }
}

// ── Venmo ───────────────────────────────────────────────────────────────
console.log('\nVenmo (simulate button)');
const venmo = await fn('applications', application('venmo', 'venmo'));
// The "application received" email is built from the same club record as this
// response, so a blank name or slug here means a blank name and a dead link there.
check('venmo: submit knows the club name and web address',
  venmo.tenant_slug === SLUG && !!venmo.tenant_display_name,
  `tenant_slug=${venmo.tenant_slug} tenant_display_name=${venmo.tenant_display_name}`);
if (check('venmo: application submitted', venmo.ok && venmo.application_id, JSON.stringify(venmo).slice(0, 160))) {
  const sim = await fn('applications', { action: 'simulate_venmo_paid', id: venmo.application_id });
  check('venmo: simulated payment accepted', sim.ok === true, JSON.stringify(sim).slice(0, 160));
  await assertMember(venmo.application_id, 'venmo', 'venmo');
}

// ── Safety ──────────────────────────────────────────────────────────────
console.log('\nSafety');
const forged = await fn('stripe_checkout', { action: 'simulate_complete', token: 'not-a-real-token' });
check('forged checkout token rejected', forged.ok === false && forged.status === 400, JSON.stringify(forged).slice(0, 160));
await sql(`update settings set value = jsonb_set(value, '{payments,test_mode}', 'false'::jsonb) where tenant_id = ${q(tenant.id)}`);
const off = await fn('applications', { action: 'simulate_venmo_paid', id: venmo.application_id || card.application_id });
check('test mode off → simulating is refused', off.ok === false && off.status === 403, JSON.stringify(off).slice(0, 160));
await sql(`update settings set value = jsonb_set(value, '{payments,test_mode}', 'true'::jsonb) where tenant_id = ${q(tenant.id)}`);
console.log('  (test mode switched back on)');

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed · ${calls} Edge Function calls`);
process.exit(failed ? 1 : 0);

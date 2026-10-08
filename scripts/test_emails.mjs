#!/usr/bin/env node
// Targeted check for the simpler Emails tab (PLAN.md T). Offline checks load
// the email registry and read the pages; they cost nothing. `--live` adds a
// few Edge Function calls with a temporary board login (its test emails go
// to Resend's test inbox), removed afterward.
//
// Usage: node scripts/test_emails.mjs [--live]
import { readFileSync, readdirSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { importTs } from './lib/importts.mjs';
import { makeTempAdmin, purgeTempAdmins } from './lib/testdata.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const LIVE = process.argv.includes('--live');
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = o => String(JSON.stringify(o)).slice(0, 260);

// email_template.ts reads Deno.env through send_email.ts; nothing is sent offline.
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };

console.log('T1 · the emails (offline)');
const et = await importTs(new URL('supabase/functions/_shared/email_template.ts', root));
{
  const list = et.EMAIL_REGISTRY;
  check('15 emails, down from 29', list.length === 15, String(list.length));
  check('each has a plain name, when it goes out, and a section',
    list.every(d => d.label && !/—|\(no app\)|TBD|Stripe/.test(d.label) && d.when && et.EMAIL_SECTIONS.some(s => s.id === d.section)), short(list.map(d => d.label)));
  check('sections in order: Signing up, Welcome, Payments, Renewals, Parties, Family changes',
    et.EMAIL_SECTIONS.map(s => s.label).join('|') === 'Signing up|Welcome|Payments|Renewals|Parties|Family changes', short(et.EMAIL_SECTIONS));
  check('the editable part is a message, not a page of HTML', list.every(d => d.default_message && !/style=|<div|<h2/.test(d.default_message)));

  // Every key the code sends still resolves (the senders are unchanged).
  const sent = new Set();
  const walk = dir => { for (const f of readdirSync(new URL(dir, root), { withFileTypes: true })) {
    if (f.isDirectory()) walk(`${dir}${f.name}/`);
    else if (f.name.endsWith('.ts') && f.name !== 'email_template.ts') {
      for (const m of read(`${dir}${f.name}`).matchAll(/'((?:application|plan|payment|party|household|auto_renew|renewal)_[a-z_]+)'/g)) sent.add(m[1]);
    } } };
  walk('supabase/functions/');
  // renewal_approved is a log entry (application_actions), not an email.
  const keys = [...sent].filter(k => k !== 'renewal_approved' && !/^(application_id|plan_id|party_id|payment_status|payment_method|plan_type|plan_fee|household_id|renewal_opens|auto_renew_[a-z]+_(at|id|year)|plan_card|plan_payoff|plan_reinstate|party_booking|payment_plan)/.test(k));
  const sentKeys = keys.filter(k => /approved|received|rejected|verified|installment|cancelled|added|auto_renew_(notice|charged)|invite|confirmed|request_received|approved_pay/.test(k));
  const unresolved = sentKeys.filter(k => !et.resolveEmail(k) && !/application_received_stripe/.test(k));
  for (const app of ['', '_no_app']) for (const v of ['stripe_paid', 'free', 'venmo_verified', 'unpaid_venmo', 'plan_first', 'other']) {
    if (!et.resolveEmail(`application_approved_${v}${app}`)) unresolved.push(`application_approved_${v}${app}`);
  }
  check('every email the app sends maps to one of the 15', unresolved.length === 0, short(unresolved));
  check('card signups still get no "received" email (the welcome comes when they pay)', !et.resolveEmail('application_received_stripe'));

  const W = (key, extra = {}) => et.composeEmail(key, null, null, { tenant_name: 'Bishop', primary_name: 'Jane', sign_in_link: 'https://x/m/verify', venmo_handle: 'bishop', club_url: 'https://x', ...extra }, { attached: true });
  check('Welcome, paid by card: says it cleared, with the sign-in button', /card payment cleared/.test(W('application_approved_stripe_paid').html) && /https:\/\/x\/m\/verify/.test(W('application_approved_stripe_paid').html));
  check('Welcome, Venmo still to pay: the Venmo handle', /@bishop/.test(W('application_approved_unpaid_venmo').html));
  check('Welcome, no app: no sign-in button, the member page instead', !/m\/verify/.test(W('application_approved_free_no_app').html) && /https:\/\/x\/m\//.test(W('application_approved_free_no_app').html));
  check('Welcome, plan: no stale "second installment on the final due date"', !/final due date/.test(W('application_approved_plan_first_no_app').html));
  check('a signed copy is mentioned when one is attached', /signed copy/.test(W('application_approved_stripe_paid').html));
  const party = et.composeEmail('party_approved_pay', null, null, { primary_name: 'Jane', party_title: 'Bday', party_date: 'Jun 5', party_time: '2 PM', price: '$250', venmo_handle: 'bishop', member_url: 'https://x/m' }, {}).html;
  check('party approved: no stale "if another member pays for the same day first"', !/same day first/.test(party) && /\$250/.test(party));
  const custom = et.composeEmail('application_approved_stripe_paid', 'Hello {{primary_name}}', '<p>Howdy {{primary_name}}!</p>', { primary_name: 'Jane', sign_in_link: 'https://x/v', club_url: 'https://x' }, {});
  check('a club\'s own words replace the message; Poolside\'s part stays', /Howdy Jane!/.test(custom.html) && /card payment cleared/.test(custom.html) && custom.subject === 'Hello Jane');

  const dirty = '<p onclick="x()">Hi <b>there</b> <a href="javascript:alert(1)">bad</a> <a href="https://ok.example">good</a></p><script>alert(1)</script><img src=x onerror=y><style>p{}</style>';
  const clean = et.cleanMessage(dirty);
  check('what a board types is kept safe: no scripts, handlers or javascript links',
    !/script|onclick|onerror|javascript:|<img|<style/i.test(clean) && /<b>there<\/b>/.test(clean) && /href="https:\/\/ok\.example"/.test(clean), clean);
}

console.log('T2 · the Emails page (offline)');
{
  const page = read('club/admin/emails.html');
  check('sections with a switch on each email', /EMAIL_SECTIONS|sections/.test(page) && /class="switch"/.test(page) && /call\('set_enabled'/.test(page));
  check('the editor is subject and message, no HTML mode', /id="ed-subject"/.test(page) && /id="ed-message"/.test(page) && !/mode-html/.test(page) && !/&lt;\/&gt; HTML/.test(page));
  check('placeholders to tap, a preview with "Show as", Send me a test, Reset', /data-ph=/.test(page) && /id="ed-variant"/.test(page) && /call\('test'/.test(page) && /call\('reset'/.test(page));
  const fn = read('supabase/functions/email_templates/index.ts');
  check('the server: list, save, set_enabled, reset, preview, test', ['list', 'save', 'set_enabled', 'reset', 'preview', 'test'].every(a => fn.includes(`action === '${a}'`)));
  check('save keeps what a board types safe', /cleanMessage\(/.test(fn));
}

console.log('T3 · Settings → Emails (offline)');
{
  const sub = read('js/admin-subtabs.js');
  const settings = sub.slice(sub.indexOf('settings: ['), sub.indexOf('],', sub.indexOf('settings: [')));
  const members = sub.slice(sub.indexOf('members: ['), sub.indexOf('],', sub.indexOf('members: [')));
  check('Emails is in the Settings strip, not Members', /emails\.html/.test(settings) && !/emails\.html/.test(members) && /'emails\.html': 'settings'/.test(sub));
  check('the help pages say Settings → Emails', !/Members → Emails/.test(read('club/admin/help/articles/post-an-announcement.md')));
  check('Payments links use the new email names', !/#tpl=application_approved_stripe_paid|#tpl=plan_installment_paid_partial/.test(read('club/admin/payments.html')));
}

if (LIVE) {
  console.log('\nLive (Bishop, temporary board login)');
  const env = Object.fromEntries(read('.env.local').split(/\r?\n/).filter(l => /^[A-Z_]+=/.test(l)).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
  const sql = async query => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${env.SUPABASE_PROJECT_REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'poolside-test-t/1.0' },
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
  let adminId = null;
  try {
    adminId = await makeTempAdmin(sql, club.id, 'Emails', ['announcements']);
    await sql(`update admin_users set email = 'delivered@resend.dev' where id = '${adminId}'`);
    const tok = jwt({ sub: adminId, kind: 'tenant_admin', tid: club.id, slug: 'bishopestates' });
    const l = await fn('email_templates', { action: 'list' }, tok);
    check('T2: the list comes in sections, 15 emails', l.ok && l.emails?.length === 15 && l.sections?.length === 6, short({ n: l.emails?.length, s: l.sections?.length }));
    const pv = await fn('email_templates', { action: 'preview', key: 'welcome', variant: 'unpaid_venmo' }, tok);
    check('T2: the preview shows a Welcome version', pv.ok && /Venmo/.test(pv.html || ''), short({ ok: pv.ok, e: pv.error }));
    const ts = await fn('email_templates', { action: 'test', key: 'welcome', subject: 'Test {{tenant_name}}', message: '<p>Hi {{primary_name}}</p>' }, tok);
    check('T2: Send me a test goes to your own email', ts.ok && ts.to === 'delivered@resend.dev', short(ts));
  } catch (e) {
    check('live run', false, e.stack || e.message);
  } finally {
    await purgeTempAdmins(sql, club.id);
    const [{ left }] = await sql(`select count(*)::int as left from admin_users where tenant_id = '${club.id}' and display_name like 'SimTest%'`);
    check('cleanup: the temporary board login is gone', left === 0, String(left));
  }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

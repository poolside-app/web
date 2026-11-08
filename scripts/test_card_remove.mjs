#!/usr/bin/env node
// Removing a saved card (PLAN.md CM5, CM6). Doug 11/8: "have a button to
// remove their card… make sure though it will auto reject all future
// payments etc.. Check all scenarios", and on a plan "Swap only until paid….
// Unless they cancel… no refund on payments", "Family only".
//
// Offline: every scenario against a pretend database and a pretend Stripe,
// the wiring (member_auth, My family, the daily run), and the card row in
// Chrome. Costs nothing.
//
// Usage: node scripts/test_card_remove.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeDb } from './lib/fake_google.mjs';

globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
const short = v => JSON.stringify(v)?.slice(0, 240);

let sc = null;
try { sc = await importTs(new URL('supabase/functions/_shared/saved_card.ts', root)); }
catch (e) { check('_shared/saved_card.ts loads', false, String(e.message).slice(0, 160)); }

// A pretend Stripe: customers with their cards; detach takes a card off.
function fakeStripe(customers, opts = {}) {
  const calls = [];
  const call = async (path, method = 'GET') => {
    calls.push(`${method} ${path}`);
    if (opts.fail && path.includes(opts.fail)) return { ok: false, status: 500, data: { error: { message: 'Stripe is down' } } };
    let m = /^customers\/([^/]+)\/payment_methods/.exec(path);
    if (m) {
      if (!customers[m[1]]) return { ok: false, status: 404, data: { error: { code: 'resource_missing', message: 'No such customer' } } };
      return { ok: true, status: 200, data: { data: customers[m[1]].map(id => ({ id, card: { brand: 'visa', last4: '4242' } })) } };
    }
    m = /^payment_methods\/([^/]+)\/detach$/.exec(path);
    if (m) {
      const owner = Object.keys(customers).find(c => customers[c].includes(m[1]));
      if (!owner) return { ok: false, status: 400, data: { error: { code: 'resource_missing', message: 'not attached' } } };
      customers[owner] = customers[owner].filter(x => x !== m[1]);
      return { ok: true, status: 200, data: { id: m[1] } };
    }
    m = /^payment_methods\/([^/]+)$/.exec(path);
    if (m) return { ok: true, status: 200, data: { id: m[1], card: { brand: 'visa', last4: '4242' } } };
    return { ok: false, status: 404, data: {} };
  };
  return { call, calls, customers };
}
const T = 't1', H = 'h1', M = 'm1';
const base = (over = {}) => ({
  households: [{ id: H, tenant_id: T, family_name: 'Smith', auto_renew: true, auto_renew_set_at: '2026-11-01', auto_renew_customer_id: 'cus_A', auto_renew_pm_id: 'pm_1', ...over.hh }],
  payment_plans: over.plans ?? [],
  payment_authorizations: [{ id: 'pa1', tenant_id: T, household_id: H, kind: 'auto_renew', revoked_at: null }],
  audit_log: [],
});
const run = async (tables, stripe) => sc.removeCards(fakeDb(tables), { tenantId: T, householdId: H, memberId: M, stripe: stripe ? stripe.call : null });

if (sc) {
  console.log('CM5 · what removing does');
  {
    const tables = base(), s = fakeStripe({ cus_A: ['pm_1', 'pm_old'] });
    const st = await sc.cardState(fakeDb(tables), T, H);
    check('a family with an auto-renew card can remove it', st.pms.includes('pm_1') && !st.blocking, short(st));
    const r = await run(tables, s);
    check('every card on their Stripe customer comes off, an old one too', r.ok && s.customers.cus_A.length === 0, short({ r, left: s.customers }));
    const hh = tables.households[0];
    check('the household keeps no card and auto-renew is off', hh.auto_renew_pm_id === null && hh.auto_renew === false, short(hh));
    check('the auto-renew consent is kept, marked revoked by them', tables.payment_authorizations[0].revoked_at && tables.payment_authorizations[0].revoked_by === M, short(tables.payment_authorizations));
    check('it\'s logged', tables.audit_log.some(a => a.kind === 'card.removed' && a.entity_id === H), short(tables.audit_log));
  }
  {
    const tables = base({ plans: [{ id: 'p1', tenant_id: T, household_id: H, status: 'active', stripe_customer_id: 'cus_B', stripe_payment_method_id: 'pm_2' }] });
    const s = fakeStripe({ cus_A: ['pm_1'], cus_B: ['pm_2'] });
    const r = await run(tables, s);
    check('on a plan with payments left: refused, swap or pay off first, or cancel (no refund)', !r.ok && r.code === 'on_plan' && /switch to another card/.test(r.error) && /pay off/.test(r.error) && /cancel/i.test(r.error) && /refunded/.test(r.error), short(r));
    check('…and nothing is touched', s.calls.length === 0 && tables.households[0].auto_renew_pm_id === 'pm_1' && tables.payment_plans[0].stripe_payment_method_id === 'pm_2', short(s.calls));
  }
  for (const status of ['cancelled', 'lapsed', 'completed']) {
    const tables = base({ hh: { auto_renew: false, auto_renew_pm_id: null, auto_renew_customer_id: null }, plans: [{ id: 'p1', tenant_id: T, household_id: H, status, stripe_customer_id: 'cus_B', stripe_payment_method_id: 'pm_2' }] });
    const s = fakeStripe({ cus_B: ['pm_2'] });
    const r = await run(tables, s);
    check(`a ${status} plan's card can be removed`, r.ok && s.customers.cus_B.length === 0 && tables.payment_plans[0].stripe_payment_method_id === null, short({ r, plan: tables.payment_plans[0] }));
  }
  {
    const tables = base({ hh: { auto_renew: false, auto_renew_pm_id: null, auto_renew_customer_id: null }, plans: [{ id: 'p1', tenant_id: T, household_id: H, status: 'waiting', stripe_customer_id: null, stripe_payment_method_id: null }] });
    const st = await sc.cardState(fakeDb(tables), T, H);
    check('a plan still waiting at Stripe\'s page has no card and blocks nothing', !st.pms.length && !st.blocking, short(st));
    const r = await run(tables, fakeStripe({}));
    check('no card saved: nothing to remove', !r.ok && r.code === 'none', short(r));
  }
  {
    const tables = base({ hh: { auto_renew_pm_id: 'sim_pm_x', auto_renew_customer_id: 'sim_cus' } });
    const s = fakeStripe({});
    const r = await run(tables, s);
    check('a test-payment card is cleared without asking Stripe', r.ok && s.calls.length === 0 && tables.households[0].auto_renew_pm_id === null, short({ r, calls: s.calls }));
  }
  {
    const tables = base(), s = fakeStripe({ cus_A: ['pm_1'] }, { fail: 'detach' });
    const r = await run(tables, s);
    check('Stripe failing: says so and changes nothing here', !r.ok && r.code === 'stripe' && tables.households[0].auto_renew_pm_id === 'pm_1', short(r));
  }
  {
    const tables = base(), s = fakeStripe({});   // the customer is gone at Stripe already
    const r = await run(tables, s);
    check('a card or customer Stripe no longer has counts as removed', r.ok && tables.households[0].auto_renew_pm_id === null, short(r));
  }
  {
    const r = await run(base(), null);
    check('no Stripe key: refused, nothing changed', !r.ok && r.code === 'stripe', short(r));
  }
  {
    const s = fakeStripe({ cus_A: ['pm_1'] });
    const label = await sc.cardLabel(s.call, 'pm_1');
    check('the card is named the way Stripe has it', label === 'Visa ending 4242', String(label));
    check('a test card is named as one', await sc.cardLabel(s.call, 'sim_pm_x') === 'Test card');
  }
}

console.log('CM5 · what it stops');
{
  const pp = read('supabase/functions/payment_plans/index.ts');
  check('approving a renewal with a saved card refuses without one', /if \(!hh\?\.auto_renew_pm_id \|\| !hh\.auto_renew_customer_id\) return \{ ok: false/.test(pp));
  const acct = read('supabase/functions/_shared/stripe_account.ts');
  check('switching Stripe accounts counts only cards still saved', /not\('stripe_payment_method_id', 'is', null\)/.test(acct) && /not\('auto_renew_pm_id', 'is', null\)/.test(acct));
  const ma = read('supabase/functions/member_auth/index.ts');
  const both = between(ma, "action === 'saved_card' || action === 'remove_card'", '// ── renew_start');
  const st = between(both, "if (action === 'saved_card') {", 'removeCards(');
  const rm = both.slice(both.indexOf("if (action === 'saved_card') {"));
  check('member_auth: saved_card says what\'s saved and whether it can come off', /cardState\(/.test(st) && /cardLabel\(/.test(st) && /can_remove/.test(st));
  check('member_auth: remove_card removes it, for the family\'s primary only', /removeCards\(/.test(rm) && /primary/.test(rm));
  check('only the family can remove it, not the board', !/removeCards\(/.test(read('supabase/functions/households_admin/index.ts')));
}

console.log('CM6 · a plan with no card is never skipped quietly');
{
  const pp = read('supabase/functions/payment_plans/index.ts');
  check('the daily run no longer skips a plan with no card', !/if \(!plan\.stripe_customer_id \|\| !plan\.stripe_payment_method_id\) continue;/.test(pp));
  const ch = between(pp, 'async function chargeInstallment', 'async function sendReceipt');
  check('…it goes the declined-card way, "no card on file"', /no card on file/i.test(ch) && /noCard/.test(ch));
}

console.log('CM5 · My family');
{
  const fam = read('m/family.html');
  check('My family loads the card row', /\/js\/saved-card\.js/.test(fam) && /id="saved-card"/.test(fam) && /saved_card/.test(fam) && /remove_card/.test(fam));
  const { launch } = await import('./demo_video/harness.mjs');
  const browser = await launch(), p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844 });
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.setContent(`<!doctype html><meta charset=utf-8><body><div id="a"></div><div id="b"></div><div id="c"></div>
    <script>${read('js/saved-card.js')}</script></body>`);
  const r = await p.evaluate(async () => {
    const out = {};
    let removed = 0, asked = '';
    window.confirm = m => { asked = m; return true; };
    SavedCard.render(document.getElementById('a'), { has_card: true, label: 'Visa ending 4242', can_remove: true }, async () => { removed++; });
    out.a = document.getElementById('a').textContent.replace(/\s+/g, ' ');
    document.querySelector('#a button').click();
    await new Promise(r => setTimeout(r, 30));
    out.asked = asked; out.removed = removed;
    SavedCard.render(document.getElementById('b'), { has_card: true, label: 'Visa ending 4242', can_remove: false, reason: 'Your payment plan charges this card for the payments left.' }, async () => {});
    out.b = document.getElementById('b').textContent.replace(/\s+/g, ' ');
    out.bBtn = !!document.querySelector('#b button');
    out.bLink = document.querySelector('#b a')?.getAttribute('href');
    SavedCard.render(document.getElementById('c'), { has_card: false }, async () => {});
    out.c = document.getElementById('c').textContent.replace(/\s+/g, ' ');
    return out;
  });
  check('shows which card, with Remove my card', /Visa ending 4242/.test(r.a) && /Remove my card/.test(r.a), r.a);
  check('asks first: nothing can be charged to it again, past payments and receipts stay', /Nothing can be charged to it again/.test(r.asked) && /receipts stay/.test(r.asked) && r.removed === 1, short(r));
  check('on a plan: why not, and Switch card instead of Remove', /payments left/.test(r.b) && !r.bBtn && r.bLink === '/m/#plan', short(r));
  check('no card: says so', /No card saved/.test(r.c), r.c);
  check('no page errors', !errors.length, errors.join('; '));
  await browser.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

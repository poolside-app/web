#!/usr/bin/env node
// Money for a signup that's gone (PLAN.md BY2, BY3; Doug 11/6, on the review:
// "yes do your idea forpayment for deleted signup"). Before an unpaid signup
// is deleted or set aside, its open Stripe page is closed, so it can't be
// paid; a payment that lands anyway gives the Treasurer a to-do.
// Offline: the helpers against the pretend database and a pretend Stripe,
// and the wiring in the functions that delete signups and take payments.
//
// Usage: node scripts/test_orphan_payments.mjs
import { readFileSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeDb } from './lib/fake_google.mjs';

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
let cc = null;
try { cc = await importTs(new URL('supabase/functions/_shared/checkout_close.ts', root)); } catch (e) { console.log('  (checkout_close did not load: ' + e.message + ')'); }

// A pretend Stripe: each session is 'open', 'complete' or 'expired'; expire
// works only on an open one, like the real thing.
function fakeStripe(sessions, { down = false } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', account: init.headers?.['Stripe-Account'] ?? null });
    if (down) throw new Error('network down');
    const m = String(url).match(/checkout\/sessions\/([^/?]+)(\/expire)?$/);
    const s = m && sessions[decodeURIComponent(m[1])];
    const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (!s) return res(404, { error: { message: 'No such checkout.session' } });
    if (m[2]) {
      if (s.status !== 'open') return res(400, { error: { message: 'Only Checkout Sessions with a status of open can be expired.' } });
      s.status = 'expired';
      return res(200, { id: m[1], status: 'expired' });
    }
    return res(200, { id: m[1], status: s.status, payment_status: s.status === 'complete' ? 'paid' : 'unpaid' });
  };
  return { fetchFn, calls };
}

console.log('BY2 · a signup\'s Stripe page closes with the signup');
check('_shared/checkout_close.ts exists', !!cc);
if (cc) {
  const KEY = 'sk_live_x', ACCT = 'acct_club';
  const one = async (sid, state, opts = {}) => {
    const st = fakeStripe(state === undefined ? {} : { [sid]: { status: state } }, opts);
    const r = await cc.closeSession(sid, { key: KEY, account: ACCT, fetchFn: st.fetchFn });
    return { r, calls: st.calls };
  };
  const open = await one('cs_live_open', 'open');
  check('an open page is closed (Stripe\'s expire, on the club\'s account)', open.r === 'closed' && open.calls[0]?.url.endsWith('/checkout/sessions/cs_live_open/expire') && open.calls[0]?.method === 'POST' && open.calls[0]?.account === ACCT, short(open));
  check('one already paid says so', (await one('cs_live_paid', 'complete')).r === 'paid');
  check('one already closed is fine', (await one('cs_live_old', 'expired')).r === 'closed');
  check('one Stripe doesn\'t know (an old test page) can\'t be paid here', (await one('cs_test_gone', undefined)).r === 'closed');
  check('Stripe not answering is "can\'t say"', (await one('cs_live_x', 'open', { down: true })).r === 'unknown');
  const noKey = await cc.closeSession('cs_live_x', { key: undefined, account: ACCT, fetchFn: fakeStripe({}).fetchFn });
  check('no Stripe key is "can\'t say"', noKey === 'unknown', short(noKey));
  const sim = fakeStripe({});
  const simR = await cc.closeSession('sim_abc', { key: KEY, account: ACCT, fetchFn: sim.fetchFn });
  check('a test-payment page never reached Stripe: nothing to close', simR === 'closed' && sim.calls.length === 0, short({ simR, calls: sim.calls }));

  const tables = () => ({
    tenants: [{ id: 't1', stripe_account_id: ACCT }],
    applications: [{ id: 'a1', tenant_id: 't1', stripe_session_id: 'cs_live_full' }, { id: 'a2', tenant_id: 't1', stripe_session_id: null }],
    payment_plans: [{ id: 'p1', application_id: 'a1' }, { id: 'p2', application_id: 'a2' }],
    payment_plan_installments: [{ id: 'i1', plan_id: 'p1', sequence: 1, stripe_session_id: 'cs_live_plan' }, { id: 'i2', plan_id: 'p1', sequence: 2, stripe_session_id: null },
      { id: 'i3', plan_id: 'p2', sequence: 1, stripe_session_id: 'sim_x' }],
  });
  const st = fakeStripe({ cs_live_full: { status: 'open' }, cs_live_plan: { status: 'open' } });
  const both = await cc.closeSignupCheckout(fakeDb(tables()), 't1', 'a1', { key: KEY, fetchFn: st.fetchFn });
  check('every page a signup has open is closed: its own and its plan\'s', both === 'closed' && st.calls.filter(c => c.method === 'POST').length === 2, short({ both, calls: st.calls }));
  const st2 = fakeStripe({ cs_live_full: { status: 'open' }, cs_live_plan: { status: 'complete' } });
  check('any one paid makes the signup "paid"', (await cc.closeSignupCheckout(fakeDb(tables()), 't1', 'a1', { key: KEY, fetchFn: st2.fetchFn })) === 'paid');
  const st3 = fakeStripe({});
  check('a signup that never reached Stripe has nothing to close', (await cc.closeSignupCheckout(fakeDb(tables()), 't1', 'a2', { key: KEY, fetchFn: st3.fetchFn })) === 'closed' && st3.calls.length === 0);
}

const apps = read('supabase/functions/applications/index.ts');
const cleanup = block(apps, "if (action === 'cron_cleanup_abandoned')", 9000);
check('the 24-hour cleanup closes the page first, and keeps the signup unless it closed', /closeSignupCheckout\(/.test(cleanup) && /!== 'closed'/.test(cleanup) && !/stripeSaysPaid/.test(cleanup));
check('so does the sweep of unpaid renewals with no family', /closeSignupCheckout\(/.test(block(cleanup, 'Orphaned renewals', 2500)));
check('setting aside an unfinished signup closes its page, and keeps it if paid', /closeSignupCheckout\(/.test(block(apps, 'async function setAsideUnfinished', 1500)));
const purge = block(apps, "if (action === 'purge')", 2600);
check('the owner\'s delete closes the page, refuses a paid one, and takes a never-started plan', /closeSignupCheckout\(/.test(purge) && /=== 'paid'/.test(purge) && /dropPlansIfUnstarted\(/.test(purge));
check('Delete for good closes each signup\'s page', /closeSignupCheckout\(/.test(read('supabase/functions/_shared/purge_household.ts')));
const co = read('supabase/functions/stripe_checkout/index.ts');
check('paying in full again closes the old page, and says so if it was paid', /closeSignupCheckout\(/.test(block(co, "if (action === 'application') {", 1800)) && /already went through/.test(block(co, "if (action === 'application') {", 1800)));
check('starting a plan again closes the old page', /closeSignupCheckout\(/.test(block(co, 'A family that went back from Stripe', 900)));
check('a plan\'s page is kept on the signup, so it can be closed', /from\('applications'\)\.update\(\{ stripe_session_id: s\.data\.id \}\)/.test(co));

console.log('\nBY3 · money for a signup that\'s gone reaches the Treasurer');
if (cc) {
  const t = cc.orphanPaymentTask({
    tenantId: 't1', tz: 'America/Los_Angeles', why: 'deleted', name: 'Jane Smith', email: 'jane@example.com',
    amountCents: 134, paidAt: '2026-11-06T14:00:00Z', paymentIntent: 'pi_1', sessionId: 'cs_live_1',
  });
  check('a to-do for the Treasurer', t.target_scopes?.includes('payments') && t.kind === 'payment.no_signup', short(t));
  check('who paid, how much, when, and what to do', t.summary === 'Jane Smith (jane@example.com) paid $1.34 by card on Nov 6 for a signup that was deleted. Refund it in Stripe, or ask them to sign up again.', t.summary);
  const c = cc.orphanPaymentTask({ tenantId: 't1', tz: 'America/Los_Angeles', why: 'closed', name: '', email: 'x@example.com', amountCents: 60000, paidAt: '2026-11-06T14:00:00Z', paymentIntent: 'pi_2', sessionId: 'cs_2' });
  check('a closed signup says so, and a missing name falls back to the email', c.summary.startsWith('x@example.com paid $600.00 by card on Nov 6 for a signup that was closed.'), c.summary);
  check('with a pop-up, the payment kept for the refund', !!t.push_title && /\$1\.34/.test(t.push_body) && t.metadata?.payment_intent === 'pi_1' && t.metadata?.stripe_session_id === 'cs_live_1' && t.metadata?.amount_cents === 134, short(t));
}
check('it goes to whoever holds the payments alert', /'payment\.no_signup': 'payments'/.test(read('supabase/functions/_shared/positions.ts')));
const wh = read('supabase/functions/stripe_webhook/index.ts');
const appBranch = block(wh, "if (kind === 'application' && md.application_id)", 2500);
check('a card payment for a signup that\'s gone or closed gets the to-do, not a silent "paid"', /orphanPayment\(/.test(appBranch) && appBranch.indexOf('orphanPayment(') < appBranch.indexOf("payment_status: 'paid'"), appBranch.slice(0, 160));
const planBranch = block(wh, "kind.startsWith('payment_plan_')", 2200);
check('so does a plan\'s first payment when the plan or its signup is gone', /orphanPayment\(/.test(planBranch) && !/if \(!club \|\| !plan\) return new Response\('Plan not found'/.test(planBranch));

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

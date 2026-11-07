#!/usr/bin/env node
// A signed payment plan agreement, and emails that follow a plan family
// through (PLAN.md CL). Doug 11/7: "If they have a payment plan, we should
// have another signature that they accept the payment and payment plan
// agreements…", and the emails "do all the emails makes sense once the member
// gets them... payment plan? got your payment...your account is active... we
// missed a payment... pay it".
//
// Offline: the agreement's words (server and screen the same), checkout's
// refusal without the signature, the PDF page, the emails and their senders,
// and in Chrome the plan picker's second signature. Costs nothing.
//
// Usage: node scripts/test_plan_agreement.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';

globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const root = new URL('../', import.meta.url);
const read = rel => { try { return readFileSync(new URL(rel, root), 'utf8'); } catch { return ''; } };
const between = (s, a, b) => { const i = s.indexOf(a); if (i < 0) return ''; const j = s.indexOf(b, i + a.length); return s.slice(i, j < 0 ? undefined : j); };
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

const INPUT = {
  clubName: 'Bishop Estates Cabana Club', todayDate: '2026-11-07',
  rows: [
    { due_date: '2026-11-07', charge_cents: 30000, today: true },
    { due_date: '2026-12-01', charge_cents: 10000, today: false },
    { due_date: '2027-01-01', charge_cents: 10000, today: false },
  ],
  totalChargeCents: 50000,
  deadlines: [{ date: '2027-05-23', pct: 75 }, { date: '2027-07-01', pct: 100 }],
  accessWhen: 'half_paid', reactivationFeeCents: 5000,
};

console.log('CL1 · the agreement');
let terms = null, lines = [], auth = '';
try {
  terms = await importTs(new URL('supabase/functions/_shared/payment_terms.ts', root));
  lines = terms.planAgreement(INPUT);
  auth = terms.planAuthorization(INPUT.clubName);
} catch (e) { check('planAgreement exists', false, String(e.message).slice(0, 120)); }
const all = lines.join('\n');
check('every payment with its date, and the total', /\$300\.00 today \(November 7\)/.test(all) && /\$100\.00 on December 1/.test(all) && /\$100\.00 on January 1/.test(all) && /\$500\.00 in all/.test(all), all.slice(0, 300));
check('charged on its date once the board approves it, a receipt each time', /once the board approves/.test(all) && /receipt/.test(all));
check('a declined card: tried again, updated in the app', /declined/.test(all) && /update your card/i.test(all));
check('the club\'s deadlines, with their real shares', /75% paid by May 23/.test(all) && /everything paid by July 1/.test(all));
check('missing one: canceled, gate access and keyfob off, back with what\'s overdue and the reactivation fee', /canceled/.test(all) && /keyfob/.test(all) && /\$50\.00 reactivation fee/.test(all));
check('when gate access starts', /gate access and keyfob start once half/.test(all));
check('pay off early; Cancel plan ends it at once, no refund', /pay off/i.test(all) && /cancel/i.test(all) && /right away/.test(all) && /refund/.test(all));
check('the authorization names the club and the dates', /I agree to this payment plan/.test(auth) && /Bishop Estates Cabana Club/.test(auth) && /dates above/.test(auth), auth);
{
  const js = read('js/plan-agreement.js');
  const win = {};
  try { new Function('window', js)(win); } catch (e) { /* reported below */ }
  const shown = win.PlanAgreement ? win.PlanAgreement.lines(INPUT) : null;
  check('the screen shows the same words, line for line', !!shown && JSON.stringify(shown) === JSON.stringify(lines) && win.PlanAgreement.authorization(INPUT.clubName) === auth,
    shown ? JSON.stringify(shown).slice(0, 160) : 'js/plan-agreement.js missing');
  const ins = { ...INPUT, accessWhen: 'card', deadlines: [{ date: '2027-04-10', pct: 50 }, { date: '2027-07-15', pct: 100 }] };
  check('…for another club\'s rules too', !!shown && JSON.stringify(win.PlanAgreement.lines(ins)) === JSON.stringify(terms.planAgreement(ins)));
}
{
  const q = read('supabase/functions/_shared/plan_quote.ts');
  check('the quote carries the reactivation fee and the club\'s name for it', /reactivation_fee_cents:/.test(between(q, 'const base: PlanQuote', '};')) && /club_name:/.test(between(q, 'const base: PlanQuote', '};')));
}

console.log('CL2 · the second signature');
{
  const sc = read('supabase/functions/stripe_checkout/index.ts');
  const ap = between(sc, "if (action === 'application_plan')", "if (action === '");
  const iSig = ap.indexOf('needs_plan_signature'), iClose = ap.indexOf('closeSignupCheckout');
  check('checkout won\'t start a plan without the signature, before anything else happens', iSig > 0 && iClose > iSig, `${iSig} ${iClose}`);
  check('…and saves the words they saw and the signature on the signup', /plan_agreement:/.test(ap) && /planAgreement\(/.test(ap) && /planAuthorization\(/.test(ap) && /signed_at/.test(ap));
  const mig = readdirSync(new URL('supabase/migrations/', root)).filter(f => /plan_agreement/.test(f));
  check('a migration adds applications.plan_agreement', mig.length === 1 && /add column if not exists plan_agreement jsonb/i.test(read(`supabase/migrations/${mig[0]}`)), mig.join(','));
  const pages = ['apply.html', 'renew.html', 'm/renew.html'];
  check('every page with the plan picker loads the agreement and a signature pad', pages.every(p => /\/js\/plan-agreement\.js/.test(read(p)) && /signature_pad/.test(read(p))), pages.filter(p => !/plan-agreement\.js/.test(read(p)) || !/signature_pad/.test(read(p))).join(', '));
  const pdf = read('supabase/functions/_shared/application_pdf.ts'), load = read('supabase/functions/_shared/sync_application.ts');
  check('the signed membership PDF has a "Payment plan agreement" page', /Payment plan agreement/.test(pdf) && /plan_agreement/.test(pdf) && /plan_agreement/.test(load));
}

console.log('CL3 · the emails');
{
  const et = await importTs(new URL('supabase/functions/_shared/email_template.ts', root));
  const text = h => h.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/\s+/g, ' ');
  const base = { tenant_name: 'Bishop Estates Cabana Club', family_name: 'Smith Family', primary_name: 'Jane Smith', club_url: 'https://x.poolsideapp.com', amount: '$300.00', season: '2027', plan_terms: lines.join('\n') };
  const w = text(et.composeEmail('application_approved_plan_first', null, null, base).html);
  check('the welcome lists "Your payment plan", in the agreement\'s words', /Your payment plan/.test(w) && /75% paid by May 23/.test(w) && /\$100\.00 on December 1/.test(w), w.slice(0, 300));
  const r = text(et.composeEmail('renewal_confirmed_plan', null, null, base).html);
  check('a renewal on a plan: "You\'re renewed", on a payment plan, with the plan', /renewed for 2027/.test(r) && /payment plan/.test(r) && /75% paid by May 23/.test(r) && !/paid through the 2027 season/.test(r), r.slice(0, 300));
  const a = text(et.composeEmail('plan_installment_paid_partial', null, null, { ...base, access_now: 'yes' }).html);
  check('the payment that reaches half: their gate access is on', /gate access is on/.test(a), a.slice(0, 300));
  const f = text(et.composeEmail('plan_installment_failed_final', null, null, { ...base, next_deadline: 'May 23' }).html);
  check('after the last try: still couldn\'t charge it, pay in the app before the deadline', /still couldn't charge/i.test(f) && /May 23/.test(f) && /canceled/.test(f) && /Pay now/.test(f), f.slice(0, 300));
  const b = text(et.composeEmail('plan_reinstated', null, null, { ...base, receipt_no: '2027-0009' }).html);
  check('paying to come back: "Welcome back", active again', /Welcome back/.test(b) && /active again/.test(b) && /2027-0009/.test(b), b.slice(0, 300));
  check('the Emails page previews the new versions', ['plan_payment_received', 'plan_payment_failed', 'renewal_confirmed'].every(k => (et.getRegistryEntry(k).variants || []).length >= 2)
    && et.EMAIL_REGISTRY.length === 21);
  const apps = read('supabase/functions/applications/index.ts'), pp = read('supabase/functions/payment_plans/index.ts'), wh = read('supabase/functions/stripe_webhook/index.ts');
  check('the welcome and the plan renewal carry the plan\'s words', /plan_terms/.test(apps) && /renewal_confirmed_plan/.test(apps + wh));
  check('the daily run says when access comes on, and tells the family after the last try', /access_now/.test(pp) && /plan_installment_failed_final/.test(pp));
  check('paying to come back sends "Welcome back"', /plan_reinstated/.test(wh));
}

console.log('CL4 · the join form\'s plan text');
check('the first deadline\'s real share, not "half"', !/when half is due/.test(read('js/plan-picker.js')));

console.log('CL2 · in Chrome');
{
  const { launch } = await import('./demo_video/harness.mjs');
  const browser = await launch(), p = await browser.newPage();
  await p.setViewport({ width: 390, height: 844 });
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  // A stand-in for signature_pad (it comes from a CDN): signing is drawing a line.
  await p.setContent(`<!doctype html><meta charset=utf-8><body><div id="area"></div>
    <script>window.SignaturePad = class { constructor(c) { this.c = c; this.d = []; } isEmpty() { return !this.d.length; } clear() { this.d = []; } fromData(d) { this.d = d; } toDataURL() { return 'data:image/png;base64,iVBORw0KGgo='; } addEventListener() {} on() {} off() {} };</script>
    <script>${read('js/plan-agreement.js')}</script><script>${read('js/plan-picker.js')}</script></body>`);
  const quote = { available: true, total_cents: 50000, min_payment_cents: 1000, access_when: 'half_paid', reactivation_fee_cents: 5000, club_name: 'Bishop Estates Cabana Club',
    months: [{ value: '2027-01', label: 'January' }], deadlines: [{ date: '2027-05-23', label: '75% paid', pct: 75 }, { date: '2027-07-01', label: 'Paid in full', pct: 100 }],
    choice: { ok: true, today_cents: 30000, payoff_month: '2027-01', rows: INPUT.rows.map((r, i) => ({ sequence: i + 1, due_date: r.due_date, today: r.today, amount_cents: r.charge_cents, plan_fee_cents: 0, card_fee_cents: 0, charge_cents: r.charge_cents })),
      totals: { dues_cents: 50000, plan_fee_cents: 0, card_fee_cents: 0, charge_cents: 50000 }, checks: [{ date: '2027-05-23', pct: 75, paid_cents: 50000 }] } };
  const st = await p.evaluate(q => {
    PlanPicker.mount(document.getElementById('area'), q, () => {});
    const box = document.getElementById('pp-agree');
    const before = { shown: !!box && /75% paid by May 23/.test(box.textContent), choice: PlanPicker.choice(), err: PlanPicker.error() };
    PlanPicker.__pad().fromData([[1]]);
    const signed = PlanPicker.choice();
    const q2 = JSON.parse(JSON.stringify(q)); q2.choice.rows[1].charge_cents = 12000; q2.choice.totals.charge_cents = 52000;
    PlanPicker.update(q2);
    return { before, signed, after: PlanPicker.choice(), afterErr: PlanPicker.error(), text: document.getElementById('area').textContent.replace(/\s+/g, ' ') };
  }, quote);
  check('the agreement shows under the schedule', st.before.shown, st.text.slice(0, 200));
  check('nothing goes to checkout until it\'s signed, and it says why', st.before.choice === null && /Sign the payment plan agreement/.test(st.before.err || ''), JSON.stringify(st.before));
  check('signed: the signature goes with the plan to checkout', !!st.signed && /^data:image\/png;base64,/.test(st.signed.plan_signature || '') && st.signed.payoff_month === '2027-01', JSON.stringify(st.signed));
  check('a changed schedule clears the signature (they agreed to other dates)', st.after === null && /Sign the payment plan agreement/.test(st.afterErr || ''), JSON.stringify(st.after));
  check('the join form\'s plan text uses the deadline\'s share', /\$\d.*paid by May 23, when 75% is due/.test(st.text) || /75% is due/.test(st.text), st.text.slice(0, 400));
  check('no page errors', !errors.length, errors.join('; '));
  await browser.close();
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

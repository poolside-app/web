#!/usr/bin/env node
// Targeted check for the choices after a refund or chargeback (PLAN.md BT,
// Doug 11/4: "keep them a member until the board member does something about
// it... make sure that we have proper options on all refunds... so like if we
// refund for a keyfob"). Offline: the choices, each one against a pretend
// database, the webhook's wiring, the Signups and Waiting for payment fixes,
// and the Refunds card in Chrome.
//
// Usage: node scripts/test_refund_options.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { importTs } from './lib/importts.mjs';
import { fakeDb } from './lib/fake_google.mjs';

const root = new URL('../', import.meta.url);
const read = rel => readFileSync(new URL(rel, root), 'utf8');
const migs = pat => readdirSync(new URL('supabase/migrations/', root)).filter(f => pat.test(f)).map(f => read(`supabase/migrations/${f}`)).join('\n');
const short = o => String(JSON.stringify(o)).slice(0, 300);
let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}

// The helpers read Deno.env and send pop-ups with fetch: stand-ins that
// record what would have gone out.
globalThis.Deno = globalThis.Deno || { env: { get: () => undefined } };
const realFetch = globalThis.fetch;
const sent = [];
globalThis.fetch = async (url, init) => {
  let body = null;
  try { body = init?.body ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
  sent.push({ url: String(url), body });
  return new Response(JSON.stringify({ ok: true, sent: 0, failed: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
};
const popsFor = hid => sent.filter(s => /push_member/.test(s.url) && (s.body?.household_ids ?? []).includes(hid));

const T = 't1';
const task = (id, kind, source_kind, source_id, metadata) => ({ id, tenant_id: T, kind, target_scopes: ['payments'], summary: id, link_url: '/club/admin/payments.html#refunds',
  source_kind, source_id, metadata, created_at: '2026-11-05T04:30:00Z', completed_at: null, completed_by: null, dismissed_at: null });
const fixture = () => fakeDb({
  tenants: [{ id: T, stripe_account_id: 'acct_1', timezone: 'America/Los_Angeles' }],
  settings: [{ tenant_id: T, value: { fundraiser: { outside_cents: 0, raised_cents: 5000 } } }],
  households: [
    { id: 'h-new', tenant_id: T, family_name: 'Rivera Family', active: true, dues_paid_for_year: true, paid_until_year: 2027 },
    { id: 'h-ren', tenant_id: T, family_name: 'Chen Family', active: true, dues_paid_for_year: true, paid_until_year: 2027 },
    { id: 'h-plan', tenant_id: T, family_name: 'Okafor Family', active: true, dues_paid_for_year: true, paid_until_year: null },
  ],
  applications: [
    { id: 'a-new', tenant_id: T, household_id: 'h-new', family_name: 'Rivera Family', status: 'approved', payment_status: 'refunded', payment_method: 'stripe', membership_year: 2027, is_renewal: false, claim_source: null, amount_due_cents: 30000 },
    { id: 'a-ren', tenant_id: T, household_id: 'h-ren', family_name: 'Chen Family', status: 'approved', payment_status: 'refunded', payment_method: 'stripe', membership_year: 2027, is_renewal: true, claim_source: null, amount_due_cents: 30000 },
    { id: 'a-plan', tenant_id: T, household_id: 'h-plan', family_name: 'Okafor Family', status: 'approved', payment_status: 'pending', payment_method: 'stripe_plan', membership_year: 2027, is_renewal: false, claim_source: null },
  ],
  payment_plans: [{ id: 'p1', tenant_id: T, household_id: 'h-plan', application_id: 'a-plan', status: 'active', family_name: 'Okafor Family' }],
  payment_plan_installments: [{ id: 'i2', tenant_id: T, plan_id: 'p1', sequence: 2, status: 'paid', stripe_payment_intent_id: 'pi_plan' }],
  keyfobs: [
    { id: 'f-on', tenant_id: T, household_id: 'h-new', status: 'active', card_number: 1234567, level: null, payment_status: 'paid', stripe_payment_intent_id: 'pi_fobs' },
    { id: 'f-req', tenant_id: T, household_id: 'h-new', status: 'requested', card_number: null, level: null, payment_status: 'paid', stripe_payment_intent_id: 'pi_fobs' },
    { id: 'f-staff', tenant_id: T, household_id: 'h-new', status: 'active', card_number: 7654321, level: 'staff', payment_status: 'none' },
  ],
  party_bookings: [{ id: 'party1', tenant_id: T, household_id: 'h-new', title: 'Pool Party', status: 'approved', payment_status: 'paid', event_id: 'ev1', pool_date: '2027-07-10', stripe_payment_intent_id: 'pi_party' }],
  events: [{ id: 'ev1', tenant_id: T, active: true }],
  access_passes: [{ id: 'pass1', tenant_id: T, source_kind: 'party', source_id: 'party1', ended_at: null }],
  programs: [{ id: 'prog1', tenant_id: T, name: 'Swim lessons' }],
  program_bookings: [{ id: 'b1', tenant_id: T, household_id: 'h-new', program_id: 'prog1', participant_name: 'Sam', status: 'confirmed', stripe_payment_intent_id: 'pi_prog' }],
  donations: [{ id: 'd1', tenant_id: T, amount_cents: 5000, donor_name: 'Pat', status: 'verified', stripe_payment_intent: 'pi_don' }],
  admin_tasks: [
    task('t-new', 'application.refund', 'application', 'a-new', { item: 'membership', application_id: 'a-new', household_id: 'h-new', amount_cents: 30927, charge_cents: 30927, full: true, payment_intent: 'pi_new' }),
    // Made before BT, with no metadata: worked out from its source.
    task('t-old', 'application.refund', 'application', 'a-ren', null),
    task('t-plan', 'payment.dispute', 'payment_plan_installment', 'i2', { item: 'membership', plan_id: 'p1', household_id: 'h-plan', amount_cents: 56674, full: true, reason: 'fraudulent', payment_intent: 'pi_plan' }),
    task('t-fobs', 'payment.refund', 'keyfob', 'f-on', { item: 'keyfobs', fob_ids: ['f-on', 'f-req'], household_id: 'h-new', amount_cents: 3121, charge_cents: 3121, full: true, payment_intent: 'pi_fobs' }),
    task('t-party', 'payment.refund', 'party_booking', 'party1', { item: 'party', party_id: 'party1', household_id: 'h-new', amount_cents: 15000, charge_cents: 15000, full: true, payment_intent: 'pi_party' }),
    task('t-prog', 'payment.refund', 'program_booking', 'b1', { item: 'program', booking_id: 'b1', household_id: 'h-new', amount_cents: 8000, charge_cents: 8000, full: true, payment_intent: 'pi_prog' }),
    task('t-don', 'payment.refund', 'donation', 'd1', { item: 'donation', donation_id: 'd1', amount_cents: 5000, charge_cents: 5000, full: true, payment_intent: 'pi_don' }),
    task('t-unk', 'payment.dispute', null, null, { unmatched: true, amount_cents: 100, payment_intent: 'pi_x' }),
    { ...task('t-done', 'payment.refund', 'donation', 'd1', { item: 'donation', donation_id: 'd1', amount_cents: 5000 }), completed_at: '2026-11-05T05:00:00Z' },
    { id: 'issue-req', tenant_id: T, kind: 'keyfob.issue', source_kind: 'keyfob', source_id: 'f-req', completed_at: null, target_scopes: ['keyfobs'], summary: 'Issue a keyfob' },
  ],
  audit_log: [],
});

let rr = null;
try { rr = await importTs(new URL('supabase/functions/_shared/refund_review.ts', root)); } catch (e) { check('the rules live in _shared/refund_review.ts', false, e.message); }

console.log('BT1–BT6 · the choices for each kind of payment');
if (rr) {
  const keys = v => (v.choices ?? []).map(c => c.key).join(',');
  const c = (item, state) => rr.choicesFor({ item, state }).map(x => x.key).join(',');
  check('a member: Keep them as members, or End their membership', c('membership', { member: true }) === 'keep,end', c('membership', { member: true }));
  check('…a family no longer a member just gets OK', c('membership', { member: false }) === 'ok');
  check('keyfobs in use or waiting: Turn off, or Keep', c('keyfobs', { fobs: [{ status: 'active' }, { status: 'requested' }] }) === 'fobs_off,keep');
  check('…fobs already off just get OK', c('keyfobs', { fobs: [{ status: 'off' }] }) === 'ok');
  check('a party: Cancel it, or Keep it', c('party', { status: 'approved' }) === 'cancel_party,keep');
  check('…one already canceled just gets OK', c('party', { status: 'cancelled' }) === 'ok');
  check('a program: Take them off, or Keep them on', c('program', { status: 'confirmed' }) === 'cancel_booking,keep');
  check('a donation: Take it off the fundraiser, or Leave it', c('donation', { status: 'verified' }) === 'off_total,keep');
  check('a payment Poolside can\'t match: OK', c('unknown', {}) === 'ok');
  const end = rr.choicesFor({ item: 'membership', state: { member: true } }).find(x => x.key === 'end');
  check('ending a membership says what happens', /unpaid/.test(end?.hint || '') && /fob/.test(end?.hint || '') && /pop-up/.test(end?.hint || ''), end?.hint);

  console.log('BT7 · refunds Poolside makes itself');
  const ref = [{ amount: 1000, metadata: { poolside_kind: 'referral_reward' } }];
  check('a referral reward paid back to the card isn\'t the board\'s refund', rr.boardRefundCents(1000, ref) === 0);
  check('…the rest of a refund still is', rr.boardRefundCents(3000, [...ref, { amount: 2000, metadata: {} }]) === 2000);
  check('with no list from Stripe, it all counts', rr.boardRefundCents(3000, null) === 3000);

  console.log('BT1 · the Refunds and chargebacks list');
  const db = fixture();
  const list = await rr.listReviews(db, T);
  const by = id => list.find(v => v.id === id);
  check('every open refund and chargeback is listed, a done one isn\'t', list.length === 8 && !by('t-done'), list.map(v => v.id).join(','));
  check('a signup refund: the family, the amount, all of it, and its choices', by('t-new')?.family === 'Rivera Family' && by('t-new')?.amount_cents === 30927 && by('t-new')?.partial === false && keys(by('t-new')) === 'keep,end', short(by('t-new')));
  check('…with a way to say how they paid instead', by('t-new')?.paid_by === true, short(by('t-new')));
  check('a to-do made before this is worked out from its signup', by('t-old')?.item === 'membership' && by('t-old')?.family === 'Chen Family' && keys(by('t-old')) === 'keep,end', short(by('t-old')));
  check('a chargeback on plan payments is about the membership, and says Stripe decides', by('t-plan')?.dispute === true && by('t-plan')?.item === 'membership' && /Stripe decides/.test(by('t-plan')?.note || ''), short(by('t-plan')));
  check('keyfobs list each fob', (by('t-fobs')?.fobs ?? []).length === 2 && keys(by('t-fobs')) === 'fobs_off,keep', short(by('t-fobs')));
  check('a party, a program, a donation', keys(by('t-party')) === 'cancel_party,keep' && keys(by('t-prog')) === 'cancel_booking,keep' && keys(by('t-don')) === 'off_total,keep');
  check('the unmatched one gets OK', keys(by('t-unk')) === 'ok' && by('t-unk')?.item === 'unknown', short(by('t-unk')));
  check('nothing changed by listing them', db.tables.households.every(h => h.dues_paid_for_year === true));
  const one = await rr.listReviews(db, T, { application_id: 'a-new' });
  check('a signup\'s details can ask for just its own', one.length === 1 && one[0].id === 't-new', one.map(v => v.id).join(','));

  console.log('BT2 · End their membership');
  {
    const d = fixture();
    const r = await rr.decideReview(d, T, 't-new', { choice: 'end', by: 'admin1' });
    const hh = d.tables.households.find(h => h.id === 'h-new');
    check('their dues go back to unpaid', r.ok && hh.dues_paid_for_year === false, short(r));
    check('a new family isn\'t counted as last season\'s member (no renewal invite)', hh.paid_until_year === null, String(hh.paid_until_year));
    const offs = d.tables.admin_tasks.filter(t => t.kind === 'keyfob.off' && !t.completed_at);
    check('the fob in use gets a "turn it off" to-do, a staff fob doesn\'t', offs.length === 1 && offs[0].source_id === 'f-on', short(offs));
    check('the family gets a pop-up', popsFor('h-new').some(p => /ended/i.test(p.body?.title || '')), short(popsFor('h-new')));
    const t = d.tables.admin_tasks.find(x => x.id === 't-new');
    check('the to-do is done, with the choice', !!t.completed_at && t.completed_by === 'admin1' && t.metadata?.decision === 'end', short(t));
    check('it\'s in the audit log', d.tables.audit_log.some(a => /ended/i.test(a.summary || '')), short(d.tables.audit_log));
    const again = await rr.decideReview(d, T, 't-new', { choice: 'end', by: 'admin1' });
    check('it can\'t be decided twice', again.ok === false, short(again));
  }
  {
    const d = fixture();
    await rr.decideReview(d, T, 't-old', { choice: 'end', by: 'admin1' });
    check('a renewing family goes back to last season', d.tables.households.find(h => h.id === 'h-ren').paid_until_year === 2026);
  }
  {
    const d = fixture();
    const r = await rr.decideReview(d, T, 't-plan', { choice: 'end', by: 'admin1' });
    const plan = d.tables.payment_plans[0];
    check('a payment plan stops: no more charges', r.ok && plan.status === 'cancelled' && plan.ended_reason === 'refunded', short(plan));
    check('…and the family\'s dues go back to unpaid', d.tables.households.find(h => h.id === 'h-plan').dues_paid_for_year === false);
  }

  console.log('BT2 · Keep them as members');
  {
    const d = fixture();
    const r = await rr.decideReview(d, T, 't-new', { choice: 'keep', paid_by: 'check', by: 'admin1' });
    const app = d.tables.applications.find(a => a.id === 'a-new');
    check('paid by check instead: the signup reads paid by check', r.ok && app.payment_method === 'check' && app.payment_status === 'paid' && /check/i.test(app.payment_reference || ''), short(app));
    check('…they stay members', d.tables.households.find(h => h.id === 'h-new').dues_paid_for_year === true && d.tables.households.find(h => h.id === 'h-new').paid_until_year === 2027);
  }
  {
    const d = fixture();
    const r = await rr.decideReview(d, T, 't-new', { choice: 'keep', by: 'admin1' });
    const app = d.tables.applications.find(a => a.id === 'a-new');
    check('kept with nothing paid instead: still reads refunded, the to-do is done', r.ok && app.payment_status === 'refunded' && !!d.tables.admin_tasks.find(t => t.id === 't-new').completed_at, short(app));
  }

  console.log('BT3 · keyfobs');
  {
    const d = fixture();
    const r = await rr.decideReview(d, T, 't-fobs', { choice: 'fobs_off', by: 'admin1' });
    check('the fob in use gets a "turn it off" to-do', r.ok && d.tables.admin_tasks.some(t => t.kind === 'keyfob.off' && t.source_id === 'f-on' && !t.completed_at));
    check('the one not handed out yet is canceled, and its "issue" to-do closed', !d.tables.keyfobs.some(f => f.id === 'f-req') && !!d.tables.admin_tasks.find(t => t.id === 'issue-req').completed_at);
    check('…with a pop-up to the family', popsFor('h-new').some(p => /keyfob/i.test(p.body?.title || '')), short(popsFor('h-new')));
  }
  {
    const d = fixture();
    await rr.decideReview(d, T, 't-fobs', { choice: 'fobs_off', fob_ids: ['f-req'], by: 'admin1' });
    check('only the ticked fobs', !d.tables.keyfobs.some(f => f.id === 'f-req') && !d.tables.admin_tasks.some(t => t.kind === 'keyfob.off'));
  }

  console.log('BT4, BT5 · a party, a program, a donation');
  {
    const d = fixture();
    const r = await rr.decideReview(d, T, 't-party', { choice: 'cancel_party', by: 'admin1' });
    check('the party is canceled, off the calendar, its doors end', r.ok && d.tables.party_bookings[0].status === 'cancelled' && d.tables.events[0].active === false && !!d.tables.access_passes[0].ended_at, short(d.tables.party_bookings[0]));
    check('…with a pop-up', popsFor('h-new').some(p => /party/i.test(p.body?.title || '')));
    const p = await rr.decideReview(d, T, 't-prog', { choice: 'cancel_booking', by: 'admin1' });
    check('the program booking is canceled', p.ok && d.tables.program_bookings[0].status === 'cancelled');
    const n = await rr.decideReview(d, T, 't-don', { choice: 'off_total', by: 'admin1' });
    check('the donation comes off the fundraiser', n.ok && d.tables.donations[0].status === 'refunded' && d.tables.settings[0].value.fundraiser.raised_cents === 0, short(d.tables.settings[0].value));
    const bad = await rr.decideReview(fixture(), T, 't-don', { choice: 'end', by: 'admin1' });
    check('a choice it doesn\'t offer is refused', bad.ok === false, short(bad));
    const ok = await rr.decideReview(d, T, 't-unk', { choice: 'ok', by: 'admin1' });
    check('the unmatched one closes with OK', ok.ok && !!d.tables.admin_tasks.find(t => t.id === 't-unk').completed_at);
  }

  console.log('BT · every kind is matched with what the choices need');
  const pm = await importTs(new URL('supabase/functions/_shared/payment_match.ts', root));
  const m = async pi => (await pm.matchPayment(fixture(), pi, 'acct_1'))?.ref;
  const fobs = await m('pi_fobs'), plan = await m('pi_plan'), party = await m('pi_party'), prog = await m('pi_prog'), don = await m('pi_don');
  check('plan payments: the membership, the plan and the family', plan?.item === 'membership' && plan?.plan_id === 'p1' && plan?.household_id === 'h-plan', short(plan));
  check('keyfobs: every fob on the payment', fobs?.item === 'keyfobs' && (fobs?.fob_ids ?? []).length === 2, short(fobs));
  check('a party, a program and a donation', party?.item === 'party' && party?.party_id === 'party1' && prog?.item === 'program' && prog?.booking_id === 'b1' && don?.item === 'donation' && don?.donation_id === 'd1', short([party, prog, don]));
}

console.log('BT · the wiring');
const hook = read('supabase/functions/stripe_webhook/index.ts');
const refundBranch = (hook.split("if (type === 'charge.refunded')")[1] || '').split("if (type === 'charge.dispute.created')")[0];
const disputeBranch = (hook.split("if (type === 'charge.dispute.created')")[1] || '').split("if (type === 'payment_intent.payment_failed')")[0];
const helper = (hook.split('async function paymentProblemTask')[1] || '').split('Deno.serve(')[0];
check('refund and chargeback to-dos open Money → Payments → Refunds', /REFUNDS_LINK/.test(refundBranch) && /REFUNDS_LINK/.test(disputeBranch) && /REFUNDS_LINK/.test(helper));
check('…and carry what the choices need', /item: 'membership'/.test(refundBranch) && /item: 'membership'/.test(disputeBranch) && /\.\.\.m\.ref/.test(helper));
check('a plan signup\'s payment status isn\'t rewritten by a refund on its first payment', /stripe_plan/.test(refundBranch) && /stripe_plan/.test(disputeBranch));
check('BT7: Poolside\'s own refunds are left out', /boardRefundCents\(/.test(refundBranch) && /\/v1\/refunds\?charge=/.test(refundBranch));
const react = (hook.split("if (kind === 'payment_plan_reactivation' && md.plan_id)")[1] || '').split('// Keyfobs (PLAN.md P, Q5)')[0];
check('BT8: a reactivation keeps its Stripe payment id', /stripe_payment_intent_id: piAll/.test(react));
const pa = read('supabase/functions/payments_admin/index.ts');
check('Waiting for payment leaves out refunded and disputed signups', /"refunded"/.test(pa) && /"partial_refund"/.test(pa) && /"disputed"/.test(pa));
check('payments_admin lists and decides them', /action === 'refund_reviews'/.test(pa) && /listReviews\(/.test(pa) && /action === 'refund_decide'/.test(pa) && /decideReview\(/.test(pa));
check('Delete for good removes to-dos about plan payments too', /\.\.\.idsOf\(insts\)/.test(read('supabase/functions/_shared/purge_household.ts')));
check('the board\'s Cancel party and the refund choice share one step', /cancelParty\(/.test(read('supabase/functions/parties_admin/index.ts')));
check('a plan can end because of a refund', /'refunded'/.test(migs(/plan_end_refunded/)));
const mem = read('club/admin/members.html');
check('Signups: a refunded signup isn\'t "Unpaid", with no Verify or Reminder', /function refundState\(/.test(mem) && /Partly refunded/.test(mem) && /Chargeback/.test(mem));
check('…and its details show the choices', /RefundReview\.render\(/.test(mem) && /refund-review\.js/.test(mem));
const pay = read('club/admin/payments.html');
check('Money → Payments has the Refunds and chargebacks card', /id="refunds-card"/.test(pay) && /refund-review\.js/.test(pay) && /RefundReview\.render\(/.test(pay));

globalThis.fetch = realFetch;

console.log('BT · the screens (offline, in Chrome)');
{
  const { launch, attach, BOARD } = await import('./demo_video/harness.mjs');
  const { respond } = await import('./demo_video/data.mjs');
  const MEMBERSHIP = { id: 't-new', dispute: false, item: 'membership', family: 'Rivera Family', what: 'their 2027 dues', amount_cents: 30927, charge_cents: 30927, partial: false,
    created_at: '2027-06-05T17:00:00Z', note: 'Refunded in Stripe. They\'re still members until you pick.', paid_by: true, application_id: 'a-new',
    choices: [{ key: 'keep', label: 'Keep them as members', hint: 'Nothing changes.' }, { key: 'end', label: 'End their membership', hint: 'Their dues go back to unpaid.', danger: true }] };
  const FOBS = { id: 't-fobs', dispute: false, item: 'keyfobs', family: 'Rivera Family', what: '2 keyfobs', amount_cents: 3121, charge_cents: 3121, partial: false,
    created_at: '2027-06-05T17:00:00Z', note: 'Refunded in Stripe.', fobs: [{ id: 'f-on', tail: '4567', status: 'active' }, { id: 'f-req', tail: null, status: 'requested' }],
    choices: [{ key: 'fobs_off', label: 'Turn off the ticked fobs', hint: '…', danger: true }, { key: 'keep', label: 'Keep them', hint: 'Nothing changes.' }] };
  const decided = [];
  const answer = (f, body, ctx) => {
    if (f === 'payments_admin' && body.action === 'refund_reviews') return { ok: true, reviews: body.application_id ? [MEMBERSHIP] : [MEMBERSHIP, FOBS] };
    if (f === 'payments_admin' && body.action === 'refund_decide') { decided.push(body); return { ok: true, done: 'Kept as members.' }; }
    if (f === 'applications' && body.action === 'list') return { ok: true, applications: [{ id: 'a-new', tenant_id: 't', family_name: 'Rivera Family', primary_name: 'Ana Rivera',
      primary_email: 'ana@example.com', status: 'approved', payment_status: 'refunded', payment_method: 'stripe', num_adults: 2, num_kids: 0, reminder_count: 0,
      decided_at: '2027-06-01T17:00:00Z', created_at: '2027-06-01T17:00:00Z', household_id: 'h-new', adults_json: [], children_json: [] }] };
    return respond(f, body, ctx);
  };
  const browser = await launch();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 390, height: 844 });
    page.on('dialog', d => d.accept());
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await attach(page, { answer });
    await page.goto(BOARD + '/club/admin/payments.html', { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForSelector('#refunds-card .rr-item', { timeout: 8000 }).catch(() => {});
    const card = await page.evaluate(() => {
      const el = document.getElementById('refunds-card');
      return { shown: !!el && getComputedStyle(el).display !== 'none', text: el?.innerText || '',
        buttons: [...(el?.querySelectorAll('button[data-choice]') ?? [])].map(b => b.textContent.trim()),
        ticks: el?.querySelectorAll('input[type="checkbox"][data-fob]').length ?? 0, paidBy: !!el?.querySelector('select[data-paid-by]') };
    });
    check('Money → Payments shows "Refunds and chargebacks"', card.shown && /Refunds and chargebacks/i.test(card.text), card.text.slice(0, 200));
    check('…each one with its choices as buttons', ['Keep them as members', 'End their membership', 'Turn off the ticked fobs', 'Keep them'].every(l => card.buttons.includes(l)), short(card.buttons));
    check('…a tick per fob, and "how they paid instead"', card.ticks === 2 && card.paidBy, short(card));
    await page.select('#refunds-card select[data-paid-by]', 'check').catch(() => {});
    await page.evaluate(() => [...document.querySelectorAll('#refunds-card button[data-choice]')].find(b => b.textContent.trim() === 'Keep them as members')?.click());
    await new Promise(r => setTimeout(r, 400));
    check('tapping a choice sends it, with how they paid', decided.some(d => d.task_id === 't-new' && d.choice === 'keep' && d.paid_by === 'check'), short(decided));
    await page.evaluate(() => { const b = document.querySelector('#refunds-card input[data-fob="f-on"]'); if (b) b.click(); });
    await page.evaluate(() => [...document.querySelectorAll('#refunds-card button[data-choice]')].find(b => b.textContent.trim() === 'Turn off the ticked fobs')?.click());
    await new Promise(r => setTimeout(r, 400));
    check('…and only the ticked fobs', decided.some(d => d.task_id === 't-fobs' && d.choice === 'fobs_off' && short(d.fob_ids) === '["f-req"]'), short(decided));
    check('no page errors on Money', !errors.length, errors.join(' | '));

    errors.length = 0;
    await page.setViewport({ width: 1200, height: 900 });
    await page.goto(BOARD + '/club/admin/members.html#applications', { waitUntil: 'networkidle0', timeout: 45000 });
    await page.waitForSelector('#app-list .app', { timeout: 8000 }).catch(() => {});
    const row = await page.evaluate(() => { const el = document.querySelector('#app-list .app'); return { text: el?.innerText || '', verify: !!el?.querySelector('[data-act="verify_payment"]'), remind: !!el?.querySelector('[data-act="remind"]') }; });
    check('Signups: a refunded signup says "Refunded", not "Unpaid"', /refunded/i.test(row.text) && !/unpaid/i.test(row.text), row.text.slice(0, 200));
    check('…with no Verify payment or Reminder', !row.verify && !row.remind, short(row));
    await page.click('#app-list .app').catch(() => {});
    await page.waitForSelector('#am-refund .rr-item', { timeout: 5000 }).catch(() => {});
    const modal = await page.evaluate(() => {
      const shown = id => { const el = document.getElementById(id); return !!el && getComputedStyle(el).display !== 'none'; };
      return { refund: document.getElementById('am-refund')?.innerText || '', verify: shown('am-verify'), remind: shown('am-remind'),
        explain: document.getElementById('am-state-explainer')?.innerText || '' };
    });
    check('its details show the same choices', /Keep them as members/.test(modal.refund) && /End their membership/.test(modal.refund), modal.refund.slice(0, 200));
    check('…and say they\'re still members until someone picks', /still members/i.test(modal.explain + modal.refund) && !modal.verify && !modal.remind, short(modal));
    check('no page errors on Signups', !errors.length, errors.join(' | '));
  } finally { await browser.close(); }
}

console.log(`\n${failed ? 'FAILED' : 'PASSED'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

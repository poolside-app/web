#!/usr/bin/env node
// Targeted check for flexible payment plans (PLAN.md M). The family picks how
// much to pay today and the month to be paid off by; the rest is split evenly
// by month and checked against the club's deadlines.
//
// The offline part costs nothing. The live part (--live) runs against a
// throwaway club with its own Stripe test account, then deletes it.
//
// Usage: node scripts/test_flex_plan.mjs [--live]   (ONLY=M4 limits the live part)
import { importTs } from './lib/importts.mjs';

const root = new URL('../', import.meta.url);
const LIVE = process.argv.includes('--live');

let passed = 0, failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
  return ok;
}
const short = o => String(JSON.stringify(o)).slice(0, 300);
const sum = rows => rows.reduce((n, r) => n + r.amount_cents, 0);

const fp = await importTs(new URL('supabase/functions/_shared/flex_plan.ts', root));
const ps = await importTs(new URL('supabase/functions/_shared/payment_schedule.ts', root));

// Doug's examples: $600, half by April 1, paid in full by June 1. The family
// signs up on November 15, 2026, for the 2027 season. Since PLAN.md S1
// (10/8) every plan payment falls on the club's billing day, the 1st unless
// the club picks another; these examples are a club billing on the 15th,
// which is the arithmetic Doug's examples were worked out with.
const SPEC_CFG = {
  milestones: [{ date: '04-01', min_pct: 50, label: 'Half paid' }, { date: '06-01', min_pct: 100, label: 'Paid in full' }],
  min_installment_cents: 2500,
};
const rulesOn = (day, cfg = SPEC_CFG) => ps.resolveRules({ ...cfg, billing_day: day }, 2027, 12);
const SPEC = rulesOn(15);
const NOV15 = '2026-11-15';

console.log('M1 · the calculator (offline)');
{
  const months = fp.payoffMonths(SPEC, NOV15);
  check('payoff months run December through June', months[0] === '2026-12' && months[months.length - 1] === '2027-06', short(months));

  // Member A: $100 today, six monthly payments December–May.
  const a = fp.flexSchedule({ totalCents: 60000, todayCents: 10000, payoffMonth: '2027-05', startDate: NOV15, rules: SPEC });
  check('A: accepted', a.ok, short(a));
  if (a.ok) {
    check('A: six monthly payments, Dec 15 through May 15',
      a.payments.length === 6 && a.payments[0].due_date === '2026-12-15' && a.payments[5].due_date === '2027-05-15', short(a.payments));
    check('A: $83.33 each, the last one adjusted',
      a.payments.slice(0, 5).every(p => p.amount_cents === 8333) && a.payments[5].amount_cents === 8335, short(a.payments.map(p => p.amount_cents)));
    check('A: adds up to exactly $600', a.today_cents + sum(a.payments) === 60000 && sum(a.schedule) === 60000);
    check('A: today is payment 1, dated today', a.schedule[0].sequence === 1 && a.schedule[0].due_date === NOV15 && a.schedule[0].amount_cents === 10000);
    const half = a.checks.find(c => c.pct === 50);
    check('A: about $433 paid by April 1, passes the half rule', half && half.paid_cents === 43332 && half.ok, short(half));
  }

  // Member B: $0 today, $100 a month December–May.
  const b = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-05', startDate: NOV15, rules: SPEC });
  check('B: accepted', b.ok, short(b));
  if (b.ok) {
    check('B: six payments of $100, nothing today',
      b.today_cents === 0 && b.payments.length === 6 && b.payments.every(p => p.amount_cents === 10000) && b.schedule.length === 6, short(b.schedule));
    const half = b.checks.find(c => c.pct === 50);
    check('B: $400 paid by April 1, passes', half && half.paid_cents === 40000 && half.ok, short(half));
  }

  // Member C: $0 today and one lump sum on May 15. The rules have to say no
  // and ask for $300 by April 1.
  const c = ps.validateSchedule({
    installments: [{ sequence: 1, due_date: '2027-05-15', amount_cents: 60000 }],
    rules: SPEC, totalCents: 60000, startDate: NOV15,
  });
  check('C: a lump sum on May 15 is refused', !c.ok);
  check('C: the reason asks for $300 by April 1', !c.ok && c.violations.some(v => v.includes('$300.00') && v.includes('2027-04-01')), short(c));

  // Joining in February, paying off in May: only one monthly payment lands
  // before April 1, so an even split misses the half rule. The answer is the
  // least to pay today that makes it work.
  const feb = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-05', startDate: '2027-02-10', rules: rulesOn(10) });
  check('Feb joiner, $0 today: refused', !feb.ok && feb.code === 'misses_deadline', short(feb));
  check('Feb joiner: told to pay at least $150 today', !feb.ok && feb.min_today_cents === 15000 && /\$150\.00/.test(feb.error), short(feb));
  const feb2 = fp.flexSchedule({ totalCents: 60000, todayCents: 15000, payoffMonth: '2027-05', startDate: '2027-02-10', rules: rulesOn(10) });
  check('Feb joiner paying $150 today: accepted', feb2.ok, short(feb2));

  // A late joiner after the half-paid date pays at least half today.
  const late = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-05', startDate: '2027-04-15', rules: SPEC });
  check('after April 1: refused with $0 today', !late.ok && late.min_today_cents === 30000, short(late));
  check('after April 1: says half was due, so $300 today', !late.ok && /\$300\.00/.test(late.error) && /today/.test(late.error), short(late));
  const late2 = fp.flexSchedule({ totalCents: 60000, todayCents: 30000, payoffMonth: '2027-05', startDate: '2027-04-15', rules: SPEC });
  check('after April 1: $300 today and $300 on May 15 is accepted',
    late2.ok && late2.payments.length === 1 && late2.payments[0].due_date === '2027-05-15' && late2.payments[0].amount_cents === 30000, short(late2));

  // After the paid-in-full date only paying in full is offered.
  const after = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-06', startDate: '2027-06-02', rules: SPEC });
  check('after June 1: no plan, pay in full only', !after.ok && after.code === 'closed', short(after));
  check('after June 1: no payoff months offered', fp.payoffMonths(SPEC, '2027-06-02').length === 0);

  // The last payment never lands after the paid-in-full date.
  const june = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-06', startDate: NOV15, rules: SPEC });
  check('paying off in June: the last payment is on June 1, not June 15',
    june.ok && june.payments[june.payments.length - 1].due_date === '2027-06-01', short(june.ok ? june.payments : june));

  // Today: $0, or at least the minimum. Not the whole thing (that's paying in full).
  const tiny = fp.flexSchedule({ totalCents: 60000, todayCents: 500, payoffMonth: '2027-05', startDate: NOV15, rules: SPEC });
  check('$5 today is refused: $0 or at least $25', !tiny.ok && tiny.code === 'today_too_small' && /\$25\.00/.test(tiny.error), short(tiny));
  const all = fp.flexSchedule({ totalCents: 60000, todayCents: 60000, payoffMonth: '2027-05', startDate: NOV15, rules: SPEC });
  check('the whole amount today is paying in full, not a plan', !all.ok && all.code === 'full', short(all));

  // Payments below the minimum are refused with a way out.
  const small = fp.flexSchedule({ totalCents: 60000, todayCents: 50000, payoffMonth: '2027-05', startDate: NOV15, rules: SPEC });
  check('$16.66 a month is under the $25 minimum: refused', !small.ok && small.code === 'payment_too_small', short(small));

  // The billing day is the 28th at most, so every month has it (S1).
  check('a billing day past the 28th is the 28th', rulesOn(31).billingDay === 28);
  const d1 = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-03', startDate: '2027-01-31', rules: ps.resolveRules(SPEC_CFG, 2027, 12) });
  check('by default every payment is on the 1st, whatever day they joined (S1)', d1.ok && d1.payments.every(p => p.due_date.endsWith('-01')), short(d1.ok ? d1.payments : d1));

  // Bishop: half by April 10, paid in full by July 15.
  const BISHOP_CFG = {
    milestones: [{ date: '04-10', min_pct: 50, label: 'Half paid' }, { date: '07-15', min_pct: 100, label: 'Paid in full' }],
    min_installment_cents: 2500,
  };
  const BISHOP = rulesOn(5, BISHOP_CFG);
  const b5 = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-07', startDate: '2026-12-05', rules: BISHOP });
  check('Bishop, Dec 5, $0 down, paid off in July: 7 payments, 4 of them by April 10',
    b5.ok && b5.payments.length === 7 && b5.checks[0].paid_cents === 34284, short(b5.ok ? b5.checks : b5));
  // Signing up on the 20th, only three payments land before April 10.
  const b20 = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-07', startDate: '2026-12-20', rules: rulesOn(20, BISHOP_CFG) });
  check('Bishop, Dec 20, $0 down, July: refused, pay at least $75 today', !b20.ok && b20.min_today_cents === 7500, short(b20));
  const b20ok = fp.flexSchedule({ totalCents: 60000, todayCents: 7500, payoffMonth: '2027-07', startDate: '2026-12-20', rules: rulesOn(20, BISHOP_CFG) });
  check('Bishop, Dec 20, $75 today: accepted, the last payment on July 15 (not the 20th)',
    b20ok.ok && b20ok.payments.length === 7 && b20ok.payments[6].due_date === '2027-07-15', short(b20ok.ok ? b20ok.payments : b20ok));
  // Bishop as it is now, billing on the 1st (S1): the same Dec 20 family
  // needs nothing down, since four payments land before April 10.
  const b1 = fp.flexSchedule({ totalCents: 60000, todayCents: 0, payoffMonth: '2027-07', startDate: '2026-12-20', rules: ps.resolveRules(BISHOP_CFG, 2027, 12) });
  check('Bishop on the 1st, Dec 20, $0 down: accepted, Jan 1 through Jul 1',
    b1.ok && b1.payments.length === 7 && b1.payments[0].due_date === '2027-01-01' && b1.payments[6].due_date === '2027-07-01', short(b1.ok ? b1.payments : b1));

  // Fees ride on each payment: the $4 plan fee, and the card fee when the
  // club passes it on. The dues part still adds up to the price.
  const fees = fp.withFees(a.ok ? a.schedule : [], { planFees: [400, 200, 200, 200, 200, 200, 200], passFee: true, pct: 0.029, fixed: 30 });
  check('fees: dues still add up to $600', fees.reduce((n, r) => n + r.amount_cents, 0) === 60000);
  check('fees: each charge = dues + plan fee + card fee, grossed up',
    fees.every(r => r.charge_cents === r.amount_cents + r.plan_fee_cents + r.card_fee_cents
      && r.charge_cents === Math.ceil((r.amount_cents + r.plan_fee_cents + 30) / (1 - 0.029))), short(fees[0]));
  const noFee = fp.withFees(b.ok ? b.schedule : [], { planFees: [0, 0, 0, 0, 0, 0], passFee: false, pct: 0.029, fixed: 30 });
  check('fees: none when waived and card fees are not passed on', noFee.every(r => r.charge_cents === r.amount_cents));

  // When the gate and fob may start.
  check('access: half paid needs $300 of $600', !fp.accessReady('half_paid', { paidCents: 29999, totalCents: 60000, cardSaved: true }) && fp.accessReady('half_paid', { paidCents: 30000, totalCents: 60000, cardSaved: true }));
  check('access: first payment', !fp.accessReady('first_payment', { paidCents: 0, totalCents: 60000, cardSaved: true }) && fp.accessReady('first_payment', { paidCents: 100, totalCents: 60000, cardSaved: true }));
  check('access: card saved', fp.accessReady('card', { paidCents: 0, totalCents: 60000, cardSaved: true }) && !fp.accessReady('card', { paidCents: 0, totalCents: 60000, cardSaved: false }));
}

console.log('M3 · the quote a family sees (offline)');
{
  const pq = await importTs(new URL('supabase/functions/_shared/plan_quote.ts', root));
  const ops = await importTs(new URL('supabase/functions/_shared/plan_ops.ts', root));
  const club = (over = {}) => ({
    tenantId: 't', slug: 'x', name: 'X', tz: 'America/Los_Angeles', today: '2026-12-20', sv: {}, opensMonth: 12,
    cfg: ops.planConfig({ payments: { plan: {
      enabled: true, access_when: 'half_paid',
      milestones: [{ date: '04-10', min_pct: 50, label: 'Half paid' }, { date: '07-15', min_pct: 100, label: 'Paid in full' }],
      billing_day: 20,   // the club in these examples bills on the 20th (S1)
      ...(over.plan || {}),
    } } }),
    passFee: true, pct: 0.029, fixed: 30, stripeAccount: 'acct_x', chargesEnabled: true, feesWaived: true, testMode: false,
    clubUrl: 'https://x.poolsideapp.com', ...over,
  });
  const WAIVED = { waived: true }, NORMAL = { waived: false };

  // Nothing picked yet on Dec 20: $0 would miss April 10, so it starts at the least that works.
  const q = pq.quotePlan(club(), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: WAIVED });
  check('quote: offered, January through July', q.available && q.months[0].value === '2027-01' && q.months.at(-1).value === '2027-07', short(q.months));
  check('quote: starts on the least that works ($75 today), and says so', q.choice.ok && q.choice.today_cents === 7500 && q.choice.adjusted, short(q.choice));
  const r0 = q.choice.rows[0];
  check('quote: each charge carries its card fee; no plan fee when waived',
    r0.today && r0.plan_fee_cents === 0 && r0.card_fee_cents === Math.ceil((7500 + 30) / 0.971) - 7500, short(r0));
  check('quote: dues add up to $600', q.choice.totals.dues_cents === 60000);

  const picked = pq.quotePlan(club(), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: WAIVED, todayCents: 0, payoffMonth: '2027-07' });
  check('quote: a family that picks $0 is told why not, with the amount to pay', !picked.choice.ok && picked.choice.min_today_cents === 7500, short(picked.choice));

  const fee = pq.quotePlan(club({ feesWaived: false, passFee: false }), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: NORMAL, todayCents: 10000, payoffMonth: '2027-04' });
  check('quote: the $4 plan fee per payment, capped at $16', fee.choice.ok && fee.choice.totals.plan_fee_cents === 1600 && fee.choice.rows.length === 5, short(fee.choice.totals));

  const single = pq.quotePlan(club({ plan: { tiers: ['family'] } }), { totalCents: 30000, tierSlug: 'single', year: 2027, policy: WAIVED });
  check('quote: not offered for a membership type the club left out', !single.available && /type/.test(single.reason), short(single));
  const off = pq.quotePlan(club({ plan: { enabled: false } }), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: WAIVED });
  check('quote: not offered when plans are off', !off.available);
  const on1 = pq.quotePlan(club({ plan: { billing_day: 1 } }), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: WAIVED, todayCents: 0, payoffMonth: '2027-07' });
  check('quote: billing on the 1st, the same family can start with $0 (S1)', on1.choice.ok && on1.choice.rows[0].due_date === '2027-01-01', short(on1.choice));
  const late = pq.quotePlan(club({ today: '2027-07-20' }), { totalCents: 60000, tierSlug: 'family', year: 2027, policy: WAIVED });
  check('quote: after July 15, pay in full only', !late.available && /paying in full/.test(late.reason), short(late));

  // The numbers the family and the board see.
  const rows = [
    { id: 'a', sequence: 1, due_date: '2026-12-20', amount_cents: 7500, plan_fee_cents: 0, card_fee_cents: 255, status: 'paid' },
    { id: 'b', sequence: 2, due_date: '2027-01-20', amount_cents: 7500, plan_fee_cents: 0, card_fee_cents: 255, status: 'retrying', last_error: 'declined' },
    { id: 'c', sequence: 3, due_date: '2027-02-20', amount_cents: 7500, plan_fee_cents: 0, card_fee_cents: 255, status: 'pending' },
  ];
  const c2 = club({ today: '2027-01-25' });
  const v = ops.planView(c2, { id: 'p', status: 'active', total_cents: 22500, family_name: 'Test', stripe_payment_method_id: 'pm_1' }, rows);
  check('view: a declined payment is past due', v.status === 'past_due' && v.paid_cents === 7500 && v.balance_cents === 15000, short(v));
  check('view: next charge is the declined one, with its card fee', v.next && v.next.date === '2027-01-20' && v.next.charge_cents === 7755);
  check('view: fob not yet (not half paid)', v.fob === 'not_yet');
  const lapsed = { id: 'p', status: 'lapsed', total_cents: 22500, family_name: 'Test', enforced_at: '2027-04-10T00:00:00Z' };
  const lv = ops.planView(c2, lapsed, rows);
  check('view: lapsed and enforced means turn the fobs off', lv.status === 'lapsed' && lv.fob === 'turn_off');
  const back = ops.reinstateAmount(c2, lapsed, rows);
  check('reinstate: what is overdue plus the $50 fee', back.ids.join() === 'b' && back.dues_cents === 7500 && back.fee_cents === 5000 && back.total_cents === 12500, short(back));
  const past = ops.reinstateAmount(club({ today: '2027-07-20' }), lapsed, rows);
  check('reinstate: after the last date, everything left is overdue', past.ids.join() === 'b,c' && past.dues_cents === 15000, short(past));
  check('settings: half paid unless the club chose otherwise', ops.planConfig({}).access_when === 'half_paid' && ops.planConfig({ payments: { plan: { access_when: 'nonsense' } } }).access_when === 'half_paid');
  check('settings: no reminder emails by default', ops.planConfig({}).reminder_days_before.length === 0);
}

console.log('M3–M6 · the screens (offline)');
{
  const { readFileSync } = await import('node:fs');
  const read = rel => readFileSync(new URL(rel, root), 'utf8');
  for (const page of ['apply.html', 'renew.html', 'm/renew.html']) {
    const src = read(page);
    check(`${page}: loads the plan picker`, src.includes('<script src="/js/plan-picker.js"></script>'));
    check(`${page}: no more "how many payments"`, !/installment_count|planCount/.test(src));
  }
  check('apply.html: sends the plan choice to checkout', /isStripePlan \? planChoice : \{\}/.test(read('apply.html')));
  check('m/index.html: shows the family their plan', /renderPlanCard\(me\.plan\)/.test(read('m/index.html')) && /plan_reinstate/.test(read('m/index.html')));
  check('payments.html: one table with status and fob', /<th>Status<\/th><th>Fob<\/th>/.test(read('club/admin/payments.html')));
  check('payments.html: the gate rule and plan types are settings', /id="plan-access"/.test(read('club/admin/payments.html')) && /id="plan-tiers"/.test(read('club/admin/payments.html')));
}

if (LIVE) {
  const { runLive } = await import('./lib/flex_plan_live.mjs');
  const r = await runLive({ check, short });
  if (r === false) failed++;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

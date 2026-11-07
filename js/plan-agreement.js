/*
 * plan-agreement.js — the payment plan agreement a plan family signs (PLAN.md CL1)
 *
 * Doug 11/7: "If they have a payment plan, we should have another signature
 * that they accept the payment and payment plan agreements". Built from the
 * schedule the server quoted. The same words, line for line, as planAgreement
 * in supabase/functions/_shared/payment_terms.ts, which checkout saves with the
 * signature; scripts/test_plan_agreement.mjs keeps them the same.
 *
 *   PlanAgreement.lines({ clubName, todayDate, rows, totalChargeCents, deadlines, accessWhen, reactivationFeeCents })
 *   PlanAgreement.authorization(clubName)
 */
(function (w) {
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function niceDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
    return m ? MONTHS[Number(m[2]) - 1] + ' ' + Number(m[3]) : String(iso || '');
  }
  function dollars(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }
  function andList(xs) {
    if (xs.length <= 1) return xs[0] || '';
    if (xs.length === 2) return xs[0] + ' and ' + xs[1];
    return xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  }
  function lines(i) {
    var pays = (i.rows || []).map(function (r) {
      return r.today ? dollars(r.charge_cents) + ' today (' + niceDate(i.todayDate) + ')' : dollars(r.charge_cents) + ' on ' + niceDate(r.due_date);
    });
    var deadlines = (i.deadlines || []).map(function (d) {
      return Number(d.pct) >= 100 ? 'everything paid by ' + niceDate(d.date) : Number(d.pct) + '% paid by ' + niceDate(d.date);
    });
    var fee = Number(i.reactivationFeeCents || 0);
    var access = i.accessWhen === 'card' ? 'Your gate access and keyfob start as soon as your card is saved.'
      : i.accessWhen === 'first_payment' ? 'Your gate access and keyfob start with your first payment.'
      : 'Your gate access and keyfob start once half your dues are paid.';
    var out = [
      'Your payments: ' + pays.join(', ') + '. ' + dollars(i.totalChargeCents) + ' in all.',
      'Each payment is charged to the card you save, on its date, once the board approves it. You get a receipt each time.',
      'If a payment is declined, we try your card again over the next two weeks, and you can update your card in the app.',
    ];
    if (deadlines.length) out.push('Your payments need to be up to date by each deadline: ' + andList(deadlines) + '.');
    out.push("If you're not paid up by a deadline, your membership is canceled and your gate access and keyfob turn off. To come back, you pay what's overdue" + (fee > 0 ? ' plus the ' + dollars(fee) + ' reactivation fee' : '') + '.');
    out.push(access);
    out.push("You can pay off the rest early any time in the app. If you cancel the plan, your membership ends right away and nothing you've paid is refunded.");
    return out;
  }
  function authorization(clubName) {
    return 'I agree to this payment plan and authorize ' + (clubName || 'the club') + ' to charge my card on the dates above.';
  }
  w.PlanAgreement = { lines: lines, authorization: authorization };
})(window);

// =============================================================================
// payment_terms.ts — what a member agrees to before we keep their card
// =============================================================================
// Stripe generates mandate text automatically for ACH and SEPA. For a card
// saved during a one-off payment, which is what Poolside does, it does not:
// the disclosure is the merchant's. Their requirement for off-session charges
// is that the member agrees to us initiating payments on their behalf, and is
// told the timing and frequency, how the amount is decided, and how to cancel.
//
// https://docs.stripe.com/payments/save-and-reuse
//
// Written as plain answers rather than terms, because those four requirements
// are the same four things a family actually wants to know — when, how much,
// how often, how do I stop it. A member who reads this should come away
// better informed, not warned off.
//
// The text lives here so the wording a member sees and the wording stored as
// evidence are the same string. Storing a version number alone would mean
// proving, a year later, what version 2 said.
// =============================================================================

/** Bump when the wording changes. Old records keep their own text. */
export const TERMS_VERSION = 2;   // 2: "approve next season" (PLAN.md R7, 2026-10-08)

export type AutoRenewTermsInput = {
  clubName: string;
  /** This season's dues for their tier, in cents. An anchor, not a promise. */
  currentDuesCents?: number | null;
  /** Season being sold, e.g. 2027. */
  year?: number | null;
  /** Days before a charge that we email them. Must match what the cron does. */
  noticeDays?: number;
};

export function autoRenewTerms(i: AutoRenewTermsInput): string[] {
  const club = i.clubName || 'the club';
  const notice = i.noticeDays ?? 14;
  const amount = Number(i.currentDuesCents ?? 0) > 0
    ? `Right now that is $${Math.round(Number(i.currentDuesCents) / 100).toLocaleString('en-US')}.`
    : '';
  void notice;   // kept in the input for old callers; there is no fixed notice period now
  return [
    `When ${i.year ? `${i.year} ` : 'next season’s '}renewals open, ${club} sends you the new price and the club's policies to approve, with this card ready. ${amount}`.trim(),
    `Nothing is charged until you approve. Approving charges this card once, for that season, or you can change how you pay then.`,
    `If you don't approve, nothing is charged. We remind you once, a week later.`,
    `It keeps going until you turn it off. You can do that any time under My family, or by asking the board.`,
  ];
}

export type PlanTermsInput = {
  clubName: string;
  /** Every installment, in order, including the one being paid now. */
  installments: Array<{ due_date: string; amount_cents: number }>;
  /** Per-payment convenience fee in cents, if any. */
  perPaymentFeeCents?: number | null;
  noticeDays?: number[];
};

function niceDate(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
}

export function planTerms(i: PlanTermsInput): string[] {
  const club = i.clubName || 'the club';
  const rows = i.installments ?? [];
  const later = rows.slice(1);
  const notice = (i.noticeDays ?? [14, 7, 1]).join(', ').replace(/, (\d+)$/, ' and $1');
  const fee = Number(i.perPaymentFeeCents ?? 0);
  const money = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;

  const out = [
    `You are paying in ${rows.length} instalment${rows.length === 1 ? '' : 's'}: ` +
      rows.map(r => `${money(r.amount_cents)} on ${niceDate(r.due_date)}`).join(', ') + '.',
  ];
  if (later.length) {
    out.push(
      `${club} will charge this card automatically for ${
        later.length === 1 ? 'the remaining payment' : `the remaining ${later.length} payments`
      } on the dates above. Nothing else is charged to it.`,
    );
    out.push(`We will text and email you ${notice} days before each one.`);
  }
  if (fee > 0) {
    out.push(`Each payment includes a ${money(fee)} plan fee, already shown in the amounts above.`);
  }
  out.push(`To change or stop the plan, contact your board — they can switch you to paying in full.`);
  return out;
}

// ── The payment plan agreement (PLAN.md CL1, Doug 11/7: "another signature
// that they accept the payment and payment plan agreements") ──────────────
// What a plan family signs, built from the schedule they picked. The screen
// shows the same words from js/plan-agreement.js; scripts/test_plan_agreement.mjs
// keeps the two line for line the same. Checkout saves these lines with the
// signature (applications.plan_agreement), the membership PDF prints them,
// and the plan emails repeat them.
export const PLAN_TERMS_VERSION = 1;

export type PlanAgreementInput = {
  clubName: string;
  /** The day they sign, for the payment taken today. */
  todayDate: string;
  rows: Array<{ due_date: string; charge_cents: number; today?: boolean }>;
  totalChargeCents: number;
  deadlines: Array<{ date: string; pct: number }>;
  accessWhen: string;
  reactivationFeeCents: number;
};

const dollars = (c: number) => `$${(Number(c || 0) / 100).toFixed(2)}`;
const andList = (xs: string[]) => xs.length <= 1 ? (xs[0] ?? '') : xs.length === 2 ? `${xs[0]} and ${xs[1]}` : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export function planAgreement(i: PlanAgreementInput): string[] {
  const pays = (i.rows ?? []).map(r => r.today
    ? `${dollars(r.charge_cents)} today (${niceDate(i.todayDate)})`
    : `${dollars(r.charge_cents)} on ${niceDate(r.due_date)}`);
  const deadlines = (i.deadlines ?? []).map(d => Number(d.pct) >= 100
    ? `everything paid by ${niceDate(d.date)}`
    : `${Number(d.pct)}% paid by ${niceDate(d.date)}`);
  const fee = Number(i.reactivationFeeCents || 0);
  const access = i.accessWhen === 'card' ? 'Your gate access and keyfob start as soon as your card is saved.'
    : i.accessWhen === 'first_payment' ? 'Your gate access and keyfob start with your first payment.'
    : 'Your gate access and keyfob start once half your dues are paid.';
  return [
    `Your payments: ${pays.join(', ')}. ${dollars(i.totalChargeCents)} in all.`,
    'Each payment is charged to the card you save, on its date, once the board approves it. You get a receipt each time.',
    'If a payment is declined, we try your card again over the next two weeks, and you can update your card in the app.',
    ...(deadlines.length ? [`Your payments need to be up to date by each deadline: ${andList(deadlines)}.`] : []),
    `If you're not paid up by a deadline, your membership is canceled and your gate access and keyfob turn off. To come back, you pay what's overdue${fee > 0 ? ` plus the ${dollars(fee)} reactivation fee` : ''}.`,
    access,
    "You can pay off the rest early any time in the app. If you cancel the plan, your membership ends right away and nothing you've paid is refunded.",
  ];
}

/** The sentence they sign under. */
export function planAuthorization(clubName: string): string {
  return `I agree to this payment plan and authorize ${clubName || 'the club'} to charge my card on the dates above.`;
}

/** The single sentence the member ticks. Kept separate so it reads as consent. */
export function authorizationSentence(clubName: string): string {
  return `I authorize ${clubName || 'the club'} to keep my card and charge it when I approve a season's renewal, on these terms.`;
}

/** Exactly what gets stored, so the record is the wording they saw. */
export function termsRecord(lines: string[], clubName: string): string {
  return [...lines, '', authorizationSentence(clubName)].join('\n');
}

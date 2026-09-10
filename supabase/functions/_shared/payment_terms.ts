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
export const TERMS_VERSION = 1;

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
  return [
    `${club} will charge this card once a year, when ${i.year ? `${i.year} ` : 'next season’s '}dues open.`,
    `The amount is whatever your membership costs that season — your board sets it, and it can change. ${amount}`.trim(),
    `We will email you ${notice} days before each charge, with the amount, so it is never a surprise.`,
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

/** The single sentence the member ticks. Kept separate so it reads as consent. */
export function authorizationSentence(clubName: string): string {
  return `I authorize ${clubName || 'the club'} to charge my saved card on these terms.`;
}

/** Exactly what gets stored, so the record is the wording they saw. */
export function termsRecord(lines: string[], clubName: string): string {
  return [...lines, '', authorizationSentence(clubName)].join('\n');
}

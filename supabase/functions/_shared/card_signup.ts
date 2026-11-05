// A signup by card or payment plan that the family hasn't paid for yet
// (PLAN.md BS4): they left Stripe's page, or the card was declined. It isn't
// the board's to approve: paying approves it on its own, and the cleanup
// deletes it 24 hours after it was made. An imported family's claimed signup
// is the club chasing a member it knows, so it stays the board's, the same
// families the cleanup skips.
export function waitingOnCard(a: Record<string, unknown>): boolean {
  return a.status === 'pending'
    && a.payment_status === 'unpaid'
    && (a.payment_method === 'stripe' || a.payment_method === 'stripe_plan')
    && a.claim_source !== 'csv_import';
}

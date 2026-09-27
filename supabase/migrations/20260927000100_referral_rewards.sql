-- =============================================================================
-- referral_rewards — refunds are recordable, so they can void a reward (H6)
-- =============================================================================
-- stripe_webhook has long written payment_status 'refunded', 'partial_refund'
-- and 'disputed' when a card payment is refunded or disputed, but the check
-- constraint only allowed unpaid/pending/paid, so those updates failed
-- silently and a refunded family still looked paid. A referral reward is void
-- if the new family's payment is refunded first (Doug, 2026-09-26), so the
-- refund has to be on the record.
-- =============================================================================

alter table public.applications drop constraint if exists applications_payment_status_chk;
alter table public.applications add constraint applications_payment_status_chk
  check (payment_status in ('unpaid', 'pending', 'paid', 'refunded', 'partial_refund', 'disputed'));

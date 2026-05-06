-- =============================================================================
-- referral_refunds — admin-disposition columns for referral reward payouts
-- =============================================================================
-- When a member chooses 'current_year_refund', the referrals row stays at
-- status='rewarded' but the actual money-out happens via admin review:
--   1. Treasurer opens "Pending refunds" → confirms both memberships are
--      legitimate (referrer active, referee paid + not a returning member)
--   2. Treasurer picks the refund channel — Stripe API for card payments,
--      manual record for Venmo/check
--   3. We log the disposition here. refund_at IS NULL means "still pending."
--
-- Status flow:
--   rewarded + refund_at IS NULL                    — pending admin action
--   rewarded + refund_at IS NOT NULL                — refund issued
--   rewarded + refund_method = 'declined'           — admin rejected (with reason)
--
-- We keep status='rewarded' regardless so member-side dashboards continue to
-- show "you got your reward" — admin disposition is internal bookkeeping.
-- =============================================================================

alter table public.referrals
  add column if not exists refund_method        text,
  add column if not exists refund_id            text,
  add column if not exists refund_amount_cents  integer,
  add column if not exists refund_at            timestamptz,
  add column if not exists refund_by            uuid,
  add column if not exists refund_decline_reason text;

create index if not exists referrals_refund_pending_idx
  on public.referrals(tenant_id, reward_chosen_at)
  where reward_type = 'current_year_refund' and refund_at is null;

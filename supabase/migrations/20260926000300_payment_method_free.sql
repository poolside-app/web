-- =============================================================================
-- payment_method_free — "Confirm, nothing to pay" (PLAN.md H5)
-- =============================================================================
-- A code or a family's referral credit can cover the whole price. Those
-- memberships are recorded as payment_method 'free': no card, no Venmo.
-- The check constraint didn't allow it, so the webhook's update failed and
-- the family was approved but left unpaid.
-- =============================================================================

alter table public.applications drop constraint if exists applications_payment_method_chk;
alter table public.applications add constraint applications_payment_method_chk
  check (payment_method is null or payment_method in ('stripe', 'stripe_plan', 'venmo', 'cash', 'check', 'manual', 'free'));

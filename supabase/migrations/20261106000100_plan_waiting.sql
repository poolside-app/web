-- PLAN.md BY1 (Doug 11/6): a plan is saved as 'waiting' when the family
-- reaches Stripe's page and turns active with Stripe's confirmation, so a
-- family who left the page is never counted or charged.
alter table public.payment_plans drop constraint if exists payment_plans_status_check;
alter table public.payment_plans add constraint payment_plans_status_check
  check (status = any (array['waiting'::text, 'active'::text, 'completed'::text, 'lapsed'::text, 'cancelled'::text]));

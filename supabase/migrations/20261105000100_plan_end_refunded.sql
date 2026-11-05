-- A payment plan can end because the board ended the family's membership
-- after a refund or chargeback (PLAN.md BT2).
alter table public.payment_plans drop constraint if exists payment_plans_ended_reason_check;
alter table public.payment_plans add constraint payment_plans_ended_reason_check
  check (ended_reason is null or ended_reason in ('card_failed', 'deadline', 'member_cancelled', 'refunded'));

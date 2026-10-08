-- Flexible payment plans (PLAN.md M, Doug 2026-10-07).
-- A family picks how much to pay today and the month to be paid off by. The
-- plan remembers both, when the family got the gate (access_at), and why it
-- ended. Each payment carries its own card fee when the club passes card fees
-- on, and the date its card first failed, so retries can be spaced out.

alter table public.payment_plans
  add column if not exists today_cents integer not null default 0,
  add column if not exists payoff_month text,
  add column if not exists access_at timestamptz,
  add column if not exists cancelled_at timestamptz,
  add column if not exists ended_reason text;

alter table public.payment_plans drop constraint if exists payment_plans_ended_reason_check;
alter table public.payment_plans add constraint payment_plans_ended_reason_check
  check (ended_reason is null or ended_reason in ('card_failed', 'deadline', 'member_cancelled'));

alter table public.payment_plan_installments
  add column if not exists card_fee_cents integer not null default 0,
  add column if not exists first_failed_at timestamptz;

alter table public.payment_plan_installments drop constraint if exists payment_plan_installments_card_fee_nonneg;
alter table public.payment_plan_installments add constraint payment_plan_installments_card_fee_nonneg
  check (card_fee_cents >= 0);

-- One live plan per application. A family that goes back from Stripe and
-- picks again replaces the plan that never started.
create index if not exists payment_plans_application_idx on public.payment_plans (application_id);
create index if not exists payment_plans_household_idx on public.payment_plans (household_id);

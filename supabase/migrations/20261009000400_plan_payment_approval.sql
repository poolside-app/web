-- Approve every automatic payment (PLAN.md S, Doug 2026-10-08: "I am very
-- concerned about random charges"). A plan payment is charged only once a
-- board member ticks it on Money → Upcoming. Approval covers its retries.
alter table public.payment_plan_installments add column if not exists approved_at timestamptz;
alter table public.payment_plan_installments add column if not exists approved_by uuid;
create index if not exists payment_plan_installments_unapproved_idx
  on public.payment_plan_installments (tenant_id, due_date) where approved_at is null and status in ('pending', 'retrying');

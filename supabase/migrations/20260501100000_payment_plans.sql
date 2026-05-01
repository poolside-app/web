-- =============================================================================
-- payment_plans + payment_plan_installments — Stripe split-payment scheduler
-- =============================================================================
-- Two-installment dues plans for clubs whose members balk at one $600 hit.
-- First installment charged at apply time, card saved off_session, second
-- installment scheduled and charged automatically on its due date.
--
-- On chronic failure (retries exhausted): plan flips to 'lapsed', household
-- dues marked unpaid, adult+teen keyfobs auto-deactivated, admin_task opened.
-- Reactivation flow charges remaining balance + a configurable reactivation
-- fee, then restores everything.
-- =============================================================================

create table if not exists public.payment_plans (
  id                       uuid primary key default gen_random_uuid(),
  tenant_id                uuid not null references public.tenants(id) on delete cascade,
  household_id             uuid references public.households(id) on delete set null,
  application_id           uuid,                                    -- non-FK so app deletion doesn't drop plan history
  plan_type                text not null default 'two_installment', -- 'two_installment' | 'full' | 'custom'
  total_cents              int  not null check (total_cents > 0),
  status                   text not null default 'active'
                           check (status in ('active','completed','lapsed','cancelled')),
  stripe_customer_id       text,
  stripe_payment_method_id text,
  primary_email            text,                                     -- denormalized for offline dunning
  primary_phone            text,
  family_name              text,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz,
  lapsed_at                timestamptz,
  reactivated_at           timestamptz
);
create index if not exists payment_plans_tenant_status_idx
  on public.payment_plans (tenant_id, status);
create index if not exists payment_plans_household_idx
  on public.payment_plans (household_id) where household_id is not null;
alter table public.payment_plans enable row level security;
drop policy if exists payment_plans_service on public.payment_plans;
create policy payment_plans_service on public.payment_plans for all using (true) with check (true);

create table if not exists public.payment_plan_installments (
  id                         uuid primary key default gen_random_uuid(),
  plan_id                    uuid not null references public.payment_plans(id) on delete cascade,
  tenant_id                  uuid not null references public.tenants(id) on delete cascade,
  sequence                   int  not null,                          -- 1, 2, ...
  due_date                   date not null,
  amount_cents               int  not null check (amount_cents >= 0),
  status                     text not null default 'pending'
                             check (status in ('pending','paid','retrying','failed','manual')),
  stripe_payment_intent_id   text,
  stripe_session_id          text,                                    -- for installment 1 (Checkout-based)
  attempt_count              int  not null default 0,
  last_attempt_at            timestamptz,
  last_error                 text,
  reminder_milestones_sent   text[] not null default '{}',            -- e.g. ['14','7','1'] day-counters already pinged
  paid_at                    timestamptz,
  created_at                 timestamptz not null default now(),
  unique(plan_id, sequence)
);
create index if not exists installments_due_pending_idx
  on public.payment_plan_installments (due_date, status) where status in ('pending','retrying');
create index if not exists installments_tenant_status_idx
  on public.payment_plan_installments (tenant_id, status);
alter table public.payment_plan_installments enable row level security;
drop policy if exists installments_service on public.payment_plan_installments;
create policy installments_service on public.payment_plan_installments for all using (true) with check (true);

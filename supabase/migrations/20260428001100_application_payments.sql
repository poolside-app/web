-- =============================================================================
-- applications: payment tracking + actions audit log
-- =============================================================================
-- payment_method: stripe | venmo | null (no preference)
-- payment_status: unpaid | pending (stripe checkout started) | paid
-- Stripe path: application.submit() → optional checkout → webhook flips to paid.
-- Venmo path: admin approves application → admin clicks "Verify Venmo" → paid.
-- Either way, dues_paid_for_year on the household flips true the moment
-- payment_status flips paid.
-- application_actions: row-per-event log so we can see who reminded + when.
-- =============================================================================

alter table public.applications add column if not exists payment_method text;
alter table public.applications add column if not exists payment_status text not null default 'unpaid';
alter table public.applications add column if not exists paid_at timestamptz;
alter table public.applications add column if not exists verified_at timestamptz;
alter table public.applications add column if not exists verified_by uuid;
alter table public.applications add column if not exists reminder_count int not null default 0;
alter table public.applications add column if not exists last_reminder_at timestamptz;
alter table public.applications add column if not exists stripe_session_id text;

do $$ begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where constraint_name = 'applications_payment_method_chk'
  ) then
    alter table public.applications add constraint applications_payment_method_chk
      check (payment_method is null or payment_method in ('stripe','venmo'));
  end if;
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where constraint_name = 'applications_payment_status_chk'
  ) then
    alter table public.applications add constraint applications_payment_status_chk
      check (payment_status in ('unpaid','pending','paid'));
  end if;
end $$;

create index if not exists applications_unpaid_idx
  on public.applications(tenant_id, payment_status, decided_at)
  where status = 'approved' and payment_status <> 'paid';

create table if not exists public.application_actions (
  id uuid primary key default gen_random_uuid(),
  application_id uuid not null references public.applications(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null,
  body text,
  actor_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists application_actions_app_idx
  on public.application_actions(application_id, created_at desc);

alter table public.application_actions enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'application_actions' and policyname = 'application_actions_service_role'
  ) then
    create policy application_actions_service_role on public.application_actions for all using (true) with check (true);
  end if;
end $$;

-- =============================================================================
-- applications — Public-submitted membership applications
-- =============================================================================
-- Visitors fill out a form on <slug>.poolsideapp.com/apply.html. Admins
-- review the queue under /club/admin/applications.html and approve. On
-- approval we auto-create the household + primary household_member and
-- link back via household_id.
-- =============================================================================

create table if not exists public.applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  family_name text not null,
  primary_name text not null,
  primary_email text,
  primary_phone text,
  address text,
  city text,
  zip text,
  num_adults int default 2,
  num_kids int default 0,
  body text,
  status text not null default 'pending',
  admin_notes text,
  decided_at timestamptz,
  decided_by uuid,
  household_id uuid references public.households(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint applications_status_chk check (status in ('pending','approved','rejected'))
);

create index if not exists applications_tenant_status_idx
  on public.applications(tenant_id, status, created_at desc);

alter table public.applications enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'applications' and policyname = 'applications_service_role'
  ) then
    create policy applications_service_role on public.applications for all using (true) with check (true);
  end if;
end $$;

-- ============================================================================
-- events: weekly / monthly recurrence
-- ============================================================================

alter table public.events add column if not exists recurrence text;
alter table public.events add column if not exists recurrence_until timestamptz;

do $$ begin
  if not exists (
    select 1 from information_schema.constraint_column_usage
    where constraint_name = 'events_recurrence_chk'
  ) then
    alter table public.events
      add constraint events_recurrence_chk
      check (recurrence is null or recurrence in ('weekly','monthly'));
  end if;
end $$;

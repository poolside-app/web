-- =============================================================================
-- programs + bookings — generalized bookings engine
-- =============================================================================
-- One model covers swim lessons / yoga / camp / clinics: a program is a
-- recurring class with a schedule, capacity, optional price, and audience.
-- A booking ties a household member to a program for its full run.
-- Payment is handled outside this table (Stripe Connect arrives later); for
-- now `paid` is a manual flag the admin can flip — same pattern dues uses.
-- =============================================================================

create table if not exists public.programs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  name            text not null,
  description     text,
  audience        text not null default 'all'  check (audience in ('kids','adults','all')),
  -- Schedule: comma-separated weekdays (mon,tue,...) + start/end time + date range.
  -- Kept loose on purpose so a club can express "Tuesday + Thursday 6pm-7pm, Jun 4–Jul 30".
  weekdays        text default 'mon,tue,wed,thu,fri',
  start_time      time,
  end_time        time,
  start_date      date,
  end_date        date,
  capacity        int  not null default 12 check (capacity >= 0),
  price_cents     int  not null default 0  check (price_cents >= 0),
  instructor      text,
  location        text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists programs_tenant_active_idx on public.programs(tenant_id, active);

create table if not exists public.program_bookings (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id)        on delete cascade,
  program_id         uuid not null references public.programs(id)       on delete cascade,
  household_id       uuid not null references public.households(id)     on delete cascade,
  -- Optional: which member of the household is the participant (a kid for
  -- swim lessons, the adult for yoga). Null = "household-level" booking.
  member_id          uuid          references public.household_members(id) on delete set null,
  participant_name   text not null,                                     -- snapshot — survives member rename/delete
  status             text not null default 'confirmed'
                     check (status in ('confirmed','waitlisted','cancelled')),
  paid               boolean not null default false,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (program_id, member_id)                                        -- prevent same kid twice (member_id null = many household bookings ok)
);

create index if not exists program_bookings_program_idx   on public.program_bookings(program_id, status);
create index if not exists program_bookings_household_idx on public.program_bookings(household_id);

alter table public.programs         enable row level security;
alter table public.program_bookings enable row level security;

drop policy if exists programs_service_role         on public.programs;
drop policy if exists program_bookings_service_role on public.program_bookings;
create policy programs_service_role         on public.programs         for all using (true) with check (true);
create policy program_bookings_service_role on public.program_bookings for all using (true) with check (true);

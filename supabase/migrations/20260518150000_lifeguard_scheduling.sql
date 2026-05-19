-- =============================================================================
-- lifeguard_scheduling — roster + shifts + signups
-- =============================================================================
-- Nothing about payroll/hours/payments here. Pure scheduling: admin creates
-- shifts, lifeguards claim them, everyone sees the resulting team schedule.
--
-- Lifeguards are SEPARATE from admin_users for two reasons:
--   1. Many lifeguards (teens) don't want a board-style admin account
--   2. A lifeguard who works the gate gets a gate_attendant admin row;
--      this lifeguards.admin_user_id column links the two so the same
--      person isn't duplicated.
--
-- When a lifeguard signs in (via the gate_attendant admin role), we resolve
-- their lifeguard_id from admin_user_id and show them their schedule.
-- =============================================================================

create table if not exists public.lifeguards (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  admin_user_id   uuid references public.admin_users(id) on delete set null,
  name            text not null,
  email           text,
  phone_e164      text,
  certifications  jsonb,            -- [{name: "Lifeguard", expires: "2027-05"}, ...]
  color           text default '#0a3b5c',  -- hex; used in schedule visualization
  notes           text,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists lifeguards_tenant_idx on public.lifeguards (tenant_id, active);
create index if not exists lifeguards_admin_user_idx on public.lifeguards (admin_user_id) where admin_user_id is not null;
alter table public.lifeguards enable row level security;
drop policy if exists lifeguards_service on public.lifeguards;
create policy lifeguards_service on public.lifeguards for all using (true) with check (true);

create table if not exists public.lifeguard_shifts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  position        text not null default 'Lifeguard',  -- "Head Lifeguard", "Junior", etc.
  spots_needed    int not null default 1,
  notes           text,
  status          text not null default 'open' check (status in ('open', 'cancelled')),
  created_by      uuid references public.admin_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists lifeguard_shifts_tenant_when_idx
  on public.lifeguard_shifts (tenant_id, starts_at);
alter table public.lifeguard_shifts enable row level security;
drop policy if exists lifeguard_shifts_service on public.lifeguard_shifts;
create policy lifeguard_shifts_service on public.lifeguard_shifts for all using (true) with check (true);

create table if not exists public.lifeguard_signups (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  shift_id        uuid not null references public.lifeguard_shifts(id) on delete cascade,
  lifeguard_id    uuid not null references public.lifeguards(id) on delete cascade,
  status          text not null default 'signed_up' check (status in ('signed_up', 'confirmed', 'released')),
  signed_up_at    timestamptz not null default now(),
  released_at     timestamptz,
  notes           text,
  unique (shift_id, lifeguard_id)
);
create index if not exists lifeguard_signups_shift_idx on public.lifeguard_signups (shift_id) where status != 'released';
create index if not exists lifeguard_signups_lg_idx    on public.lifeguard_signups (lifeguard_id, status);
alter table public.lifeguard_signups enable row level security;
drop policy if exists lifeguard_signups_service on public.lifeguard_signups;
create policy lifeguard_signups_service on public.lifeguard_signups for all using (true) with check (true);

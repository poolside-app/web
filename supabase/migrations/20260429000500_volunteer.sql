-- =============================================================================
-- volunteer_opportunities + volunteer_signups
-- =============================================================================
-- "We need 4 parents for snack-bar shifts during the swim meet" — a one-shot
-- ask the board can post and members can claim a slot for. Distinct from
-- programs (recurring class schedule) because volunteer ops are usually
-- pinned to a single date and a single event.
-- =============================================================================

create table if not exists public.volunteer_opportunities (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  title           text not null,
  description     text,
  starts_at       timestamptz not null,
  ends_at         timestamptz,
  slots_needed    int not null default 1 check (slots_needed >= 0),
  location        text,
  -- Optional link back to the calendar event this opportunity supports
  event_id        uuid references public.events(id) on delete set null,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists volunteer_opps_tenant_active_idx
  on public.volunteer_opportunities(tenant_id, active, starts_at);

create table if not exists public.volunteer_signups (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  opportunity_id     uuid not null references public.volunteer_opportunities(id) on delete cascade,
  household_id       uuid not null references public.households(id) on delete cascade,
  member_id          uuid          references public.household_members(id) on delete set null,
  volunteer_name     text not null,
  status             text not null default 'confirmed'
                     check (status in ('confirmed','cancelled')),
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (opportunity_id, member_id)   -- prevent same member claiming twice
);

create index if not exists volunteer_signups_opp_idx
  on public.volunteer_signups(opportunity_id, status);
create index if not exists volunteer_signups_household_idx
  on public.volunteer_signups(household_id);

alter table public.volunteer_opportunities enable row level security;
alter table public.volunteer_signups       enable row level security;

drop policy if exists volunteer_opportunities_service_role on public.volunteer_opportunities;
drop policy if exists volunteer_signups_service_role       on public.volunteer_signups;
create policy volunteer_opportunities_service_role on public.volunteer_opportunities for all using (true) with check (true);
create policy volunteer_signups_service_role       on public.volunteer_signups       for all using (true) with check (true);

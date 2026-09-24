-- =============================================================================
-- pool_time_zone — every club keeps its own time zone
-- =============================================================================
-- Until now nothing knew where a pool is. The server formatted times in UTC
-- (a 2 PM party emailed as "9:00 PM"), decided which day a party falls on in
-- UTC (anything after 5 PM Pacific counted as tomorrow, so two parties could
-- book the same evening), and screens showed whatever zone the viewer's phone
-- was set to.
--
-- tenants.timezone is an IANA name. Existing clubs are all in California, so
-- the default is Pacific; new clubs take it from the signup browser.
-- =============================================================================

alter table public.tenants
  add column if not exists timezone text not null default 'America/Los_Angeles';

-- A CHECK can't validate this (the zone list isn't immutable), so a trigger
-- asks Postgres itself: `at time zone` raises "time zone ... not recognized"
-- for anything it can't use.
create or replace function public.fn_tenants_check_timezone()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform now() at time zone new.timezone;
  return new;
end;
$$;

drop trigger if exists tenants_check_timezone on public.tenants;
create trigger tenants_check_timezone
  before insert or update of timezone on public.tenants
  for each row execute function public.fn_tenants_check_timezone();

-- ── One party per POOL day ──────────────────────────────────────────────────
-- The unique index used (starts_at at time zone 'UTC')::date. An index can't
-- look up each club's zone, so the pool's date is stamped on the row by a
-- trigger and the index keys on that instead.
alter table public.party_bookings
  add column if not exists pool_date date;

create or replace function public.fn_party_bookings_pool_date()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.pool_date := (new.starts_at at time zone
    coalesce((select timezone from public.tenants where id = new.tenant_id), 'America/Los_Angeles'))::date;
  return new;
end;
$$;

drop trigger if exists party_bookings_pool_date on public.party_bookings;
create trigger party_bookings_pool_date
  before insert or update of starts_at, tenant_id on public.party_bookings
  for each row execute function public.fn_party_bookings_pool_date();

update public.party_bookings pb
   set pool_date = (pb.starts_at at time zone t.timezone)::date
  from public.tenants t
 where t.id = pb.tenant_id;

drop index if exists public.party_bookings_one_per_day_uniq;
drop index if exists public.party_bookings_starts_day_idx;

create unique index if not exists party_bookings_one_per_pool_day_uniq
  on public.party_bookings (tenant_id, pool_date)
  where status = 'approved' and payment_status = 'paid';

create index if not exists party_bookings_pool_date_idx
  on public.party_bookings (tenant_id, pool_date);

-- A club moving zones (rare: a typo at signup) re-stamps its parties.
create or replace function public.fn_tenants_restamp_party_dates()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.timezone is distinct from old.timezone then
    update public.party_bookings
       set pool_date = (starts_at at time zone new.timezone)::date
     where tenant_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists tenants_restamp_party_dates on public.tenants;
create trigger tenants_restamp_party_dates
  after update of timezone on public.tenants
  for each row execute function public.fn_tenants_restamp_party_dates();

revoke all on function public.fn_tenants_check_timezone() from public, anon, authenticated;
revoke all on function public.fn_party_bookings_pool_date() from public, anon, authenticated;
revoke all on function public.fn_tenants_restamp_party_dates() from public, anon, authenticated;

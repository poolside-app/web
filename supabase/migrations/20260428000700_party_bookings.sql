-- =============================================================================
-- party_bookings — Member-initiated party rental requests
-- =============================================================================
-- Members POST a request through member_auth → request_party. Admins see the
-- queue in /club/admin/parties.html and approve/reject through parties_admin.
-- On approval an events row is materialized (kind='party') and linked here
-- via event_id so the calendar reflects the booking automatically.
-- =============================================================================

create table if not exists public.party_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  requested_by uuid references public.household_members(id) on delete set null,
  title text not null,
  body text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  expected_guests int,
  location text,
  status text not null default 'pending',
  admin_notes text,
  decided_at timestamptz,
  decided_by uuid,
  event_id uuid references public.events(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint party_bookings_status_chk
    check (status in ('pending','approved','rejected','cancelled')),
  constraint party_bookings_ends_after_starts_chk
    check (ends_at is null or ends_at >= starts_at)
);

create index if not exists party_bookings_tenant_status_idx
  on public.party_bookings(tenant_id, status, starts_at);
create index if not exists party_bookings_household_idx
  on public.party_bookings(household_id, created_at desc);

alter table public.party_bookings enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'party_bookings' and policyname = 'party_bookings_service_role'
  ) then
    create policy party_bookings_service_role on public.party_bookings for all using (true) with check (true);
  end if;
end $$;

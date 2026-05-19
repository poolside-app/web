-- =============================================================================
-- pool_checkins — audit log of who entered the pool, when, via what mechanism
-- =============================================================================
-- Written by the lifeguard check-in page (admin scope: 'check_in') and the
-- member's own pool-pass view (when the member taps "I'm here"). Used by the
-- admin Insights page to show capacity over time, peak hours, and per-family
-- usage. Also serves as the evidence record if there's an incident or an
-- insurance question about who was on the property when.
--
-- We DON'T enforce uniqueness — a family member can be "checked in" multiple
-- times in a day (leave and come back). De-duping is a UI concern.
-- =============================================================================

create table if not exists public.pool_checkins (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  household_id    uuid references public.households(id) on delete set null,
  member_id       uuid references public.household_members(id) on delete set null,
  family_name     text,                              -- snapshot at check-in time (households can rename)
  member_name     text,
  party_size      int not null default 1,            -- "Family of 4 came in"
  guest_count     int not null default 0,            -- non-members brought along (counts against guest passes if applicable)
  method          text not null default 'lifeguard', -- 'lifeguard' | 'member_pass' | 'kiosk' | 'keyfob' | 'manual'
  checked_in_at   timestamptz not null default now(),
  checked_in_by   uuid references public.admin_users(id) on delete set null,
  notes           text
);

-- Hot-path queries: today's checkins, this week's checkins, per-household history
create index if not exists pool_checkins_tenant_when_idx
  on public.pool_checkins (tenant_id, checked_in_at desc);
create index if not exists pool_checkins_household_when_idx
  on public.pool_checkins (tenant_id, household_id, checked_in_at desc);

alter table public.pool_checkins enable row level security;
drop policy if exists pool_checkins_service on public.pool_checkins;
create policy pool_checkins_service on public.pool_checkins for all using (true) with check (true);

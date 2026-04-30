-- =============================================================================
-- guest_pass_packs + guest_pass_uses
-- =============================================================================
-- Pool clubs almost universally let members bring guests for a fee. Two
-- shapes show up in the wild:
--   - "$5 per guest at the gate"  — single uses
--   - "buy a 10-pack for $40"     — pre-paid bundle
-- Both fit one model: a pack with total_count + used_count. The 1-pack flow
-- is just a special case (total=1).
--
-- Payment is a manual `paid` flag for now (matches dues / programs); Stripe
-- Connect arrives later and flips it on checkout success.
-- =============================================================================

create table if not exists public.guest_pass_packs (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  household_id  uuid not null references public.households(id) on delete cascade,
  label         text not null default 'Guest passes',
  total_count   int  not null default 1 check (total_count > 0),
  used_count    int  not null default 0 check (used_count >= 0),
  paid          boolean not null default false,
  price_cents   int  not null default 0 check (price_cents >= 0),
  -- Optional expiry — clubs that run "summer-only" packs use this; leave
  -- null for "good until used".
  expires_on    date,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Sanity: can't have used more than were sold.
  check (used_count <= total_count)
);

create index if not exists guest_pass_packs_tenant_idx
  on public.guest_pass_packs(tenant_id, active);
create index if not exists guest_pass_packs_household_idx
  on public.guest_pass_packs(household_id, active);

create table if not exists public.guest_pass_uses (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  pack_id             uuid not null references public.guest_pass_packs(id) on delete cascade,
  household_id        uuid not null references public.households(id) on delete cascade,
  guest_name          text not null,
  redeemed_by_member  uuid references public.household_members(id) on delete set null,
  redeemed_by_label   text,                                  -- snapshot — survives member rename
  notes               text,
  redeemed_at         timestamptz not null default now()
);

create index if not exists guest_pass_uses_pack_idx
  on public.guest_pass_uses(pack_id, redeemed_at);
create index if not exists guest_pass_uses_household_idx
  on public.guest_pass_uses(household_id, redeemed_at);

alter table public.guest_pass_packs enable row level security;
alter table public.guest_pass_uses  enable row level security;

drop policy if exists guest_pass_packs_service_role on public.guest_pass_packs;
drop policy if exists guest_pass_uses_service_role  on public.guest_pass_uses;
create policy guest_pass_packs_service_role on public.guest_pass_packs for all using (true) with check (true);
create policy guest_pass_uses_service_role  on public.guest_pass_uses  for all using (true) with check (true);

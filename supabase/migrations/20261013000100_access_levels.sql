-- PLAN.md AR: doors, access levels and passes (Doug, 10/13).
--
-- Access levels live in settings.access (levels with their doors, days,
-- hours and end date; the doors a party host gets). Rules and defaults:
-- _shared/access.ts. Each keyfob has a level (keyfobs.level: 'member' or
-- 'board'). A pass gives a family extra doors for a set time; for now it
-- opens them from the app, later it goes onto their keyfobs (P5).

create table if not exists public.access_passes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  doors text[] not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  note text,
  source_kind text,                 -- 'party' when a paid party gave it; null when a board member did
  source_id uuid,
  created_by uuid references public.admin_users(id) on delete set null,
  ended_at timestamptz,             -- ended early by the board, or the party was canceled
  created_at timestamptz not null default now(),
  constraint access_passes_window check (ends_at > starts_at),
  constraint access_passes_doors check (cardinality(doors) between 1 and 12)
);
create index if not exists access_passes_household on public.access_passes (tenant_id, household_id, ends_at);
create index if not exists access_passes_tenant_ends on public.access_passes (tenant_id, ends_at);
-- One pass per party. Not partial, so upserts can use it; board passes
-- (source null) never clash, since nulls are distinct in a unique index.
create unique index if not exists access_passes_source on public.access_passes (tenant_id, source_kind, source_id);
alter table public.access_passes enable row level security;

alter table public.keyfobs
  add column if not exists level text not null default 'member';
alter table public.keyfobs drop constraint if exists keyfobs_level_check;
alter table public.keyfobs add constraint keyfobs_level_check check (level ~ '^[a-z0-9_]{1,32}$');

alter table public.gate_unlocks
  add column if not exists pass_id uuid references public.access_passes(id) on delete set null;

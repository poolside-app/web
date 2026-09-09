-- =============================================================================
-- late_fees — the club charges for late dues; Poolside processes it
-- =============================================================================
-- Clubs already chase late dues and most already charge something for it,
-- inconsistently, by hand, and usually by whoever on the board is willing to
-- have the conversation. This puts it in the product.
--
-- Three deliberate constraints, because a late fee on a volunteer community
-- pool is socially loaded in a way a programme fee is not:
--
--   OFF BY DEFAULT. late_fee_enabled defaults to false for every tenant,
--   including existing ones. A club opts in; nothing is ever charged because
--   a migration ran.
--
--   ONE PER HOUSEHOLD PER SEASON. Enforced by a unique index, not by
--   application care. The assessing job runs daily; without the index a
--   household that stayed unpaid for a fortnight would be charged fourteen
--   times, and the first anyone would hear of it is a member's card
--   statement.
--
--   ALWAYS WAIVABLE. A board member can waive any fee, in one click, with no
--   approval step. A family that is late on $600 of dues may be having a hard
--   year, and a treasurer who cannot quietly make it go away will simply
--   switch the whole feature off — which helps nobody.
--
-- Poolside takes 5% of a late fee that is actually collected, the rate
-- already published on /pricing.html. It is a small line and is meant to be:
-- the return on this feature is dues arriving at all, which is where the 1%
-- lives, not the fee itself.
-- =============================================================================

-- ── club configuration ──────────────────────────────────────────────────────
alter table public.tenants
  add column if not exists late_fee_enabled     boolean not null default false,
  add column if not exists late_fee_cents       int     not null default 2500,
  add column if not exists late_fee_grace_days  int     not null default 14,
  -- The date dues are due for the current season. Null means the club has
  -- not set one, and no fee can be assessed: "late" is meaningless without
  -- something to be late relative to.
  add column if not exists dues_due_date        date;

alter table public.tenants
  drop constraint if exists tenants_late_fee_sane;
alter table public.tenants
  add constraint tenants_late_fee_sane
  check (late_fee_cents >= 0 and late_fee_cents <= 20000);

alter table public.tenants
  drop constraint if exists tenants_late_fee_grace_sane;
alter table public.tenants
  add constraint tenants_late_fee_grace_sane
  check (late_fee_grace_days >= 0 and late_fee_grace_days <= 180);

-- ── the fees themselves ─────────────────────────────────────────────────────
create table if not exists public.late_fees (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id)   on delete cascade,
  household_id   uuid not null references public.households(id) on delete cascade,

  -- Which season this fee belongs to. Part of the uniqueness guarantee, and
  -- what stops last year's unpaid fee blocking this year's assessment.
  season_year    int  not null,

  -- Captured at assessment, not read from the tenant at payment time: a club
  -- that raises its late fee in July must not silently re-price a fee a
  -- household was told about in June.
  amount_cents   int  not null,

  status         text not null default 'assessed',

  assessed_at    timestamptz not null default now(),
  -- What it was assessed against, kept for the argument that follows six
  -- weeks later about whether the fee was fair.
  due_date       date not null,
  grace_days     int  not null,

  paid_at        timestamptz,
  waived_at      timestamptz,
  waived_by      uuid,
  waive_reason   text,

  notified_at    timestamptz,
  created_at     timestamptz not null default now()
);

alter table public.late_fees
  drop constraint if exists late_fees_status_known;
alter table public.late_fees
  add constraint late_fees_status_known
  check (status in ('assessed', 'paid', 'waived', 'voided'));

alter table public.late_fees
  drop constraint if exists late_fees_amount_nonneg;
alter table public.late_fees
  add constraint late_fees_amount_nonneg
  check (amount_cents >= 0);

-- The guard that matters. See the header.
create unique index if not exists late_fees_one_per_household_season
  on public.late_fees (tenant_id, household_id, season_year);

create index if not exists late_fees_tenant_status_idx
  on public.late_fees (tenant_id, status, assessed_at desc);

alter table public.late_fees enable row level security;
drop policy if exists late_fees_service_role on public.late_fees;
create policy late_fees_service_role on public.late_fees
  for all to service_role using (true) with check (true);

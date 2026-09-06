-- =============================================================================
-- membership_year — which season a payment actually buys
-- =============================================================================
-- Until now "what year is this membership for" was inferred at write time with
-- `new Date().getFullYear()` in nine separate places. That is correct only when
-- people pay during the season they are paying for. It breaks the moment a club
-- sells next summer early: a member paying in December 2026 for the 2027 season
-- was being recorded as paid through 2026, i.e. already expired.
--
-- The year now travels with the application — the thing that knows what was
-- bought — and every downstream write copies it onto the household instead of
-- guessing from the clock.
--
-- This also repairs a live bug: stripe_webhook selected
-- `applications.paid_until_year`, a column that never existed. PostgREST
-- rejects the whole select (42703), the code ignored the error, and so
-- `households.dues_paid_for_year` was never set after a card payment. The
-- column it wanted is membership_year, added here.
--
-- Renewal support rides along: a renewal is an application with is_renewal=true
-- and household_id already set, so it reuses the existing payment, PDF, audit
-- and email plumbing rather than needing a parallel path of its own.
-- =============================================================================

alter table public.applications
  add column if not exists membership_year int,
  add column if not exists is_renewal      boolean not null default false;

comment on column public.applications.membership_year is
  'The season this application pays for. Copied to households.paid_until_year on approval/payment.';
comment on column public.applications.is_renewal is
  'True when an existing household is renewing; household_id is set and no review is required.';

-- Households opt in to being charged automatically each year. The Stripe ids
-- mirror what payment_plans already stores for off-session installment charges;
-- reusing that shape means the renewal charger and the installment charger can
-- share one code path.
alter table public.households
  add column if not exists auto_renew             boolean not null default false,
  add column if not exists auto_renew_customer_id text,
  add column if not exists auto_renew_pm_id       text,
  add column if not exists auto_renew_set_at      timestamptz;

comment on column public.households.auto_renew is
  'Member asked to be charged automatically for each new season.';

-- The renewal queue: "who has not paid for the year we are currently selling".
create index if not exists households_paid_until_year_idx
  on public.households (tenant_id, paid_until_year)
  where active;

-- Admin review queue and member "do I already have one open?" both filter here.
create index if not exists applications_membership_year_idx
  on public.applications (tenant_id, membership_year, status);

-- One open renewal per household per season. Partial + unique so a household
-- cannot end up with two half-finished renewals for the same year, while
-- historical (approved/rejected) rows stay unconstrained.
create unique index if not exists applications_one_open_renewal_idx
  on public.applications (tenant_id, household_id, membership_year)
  where is_renewal and status in ('prefilled', 'pending');

-- Backfill: everything so far was bought during the season it was for, so the
-- creation year is the right answer for existing rows.
update public.applications
   set membership_year = extract(year from created_at)::int
 where membership_year is null;

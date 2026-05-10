-- =============================================================================
-- party_bookings: payment + policy columns for the full booking lifecycle
-- =============================================================================
-- Original schema (20260428000700) covered request → approve/reject only. The
-- complete flow (per the 2026-05-09 product spec) requires:
--   • A price (set at request time from the tenant's flat party_price_cents)
--   • Payment method + status (Stripe or Venmo, paid/unpaid/pending verify)
--   • Policy/rules acceptance recorded for legal evidence
--   • Day-blocking — no two confirmed parties on the same calendar day
-- =============================================================================

alter table public.party_bookings
  add column if not exists price_cents int,
  add column if not exists payment_method text,
  add column if not exists payment_status text not null default 'unpaid',
  add column if not exists paid_at timestamptz,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_by uuid references public.admin_users(id),
  add column if not exists stripe_session_id text,
  add column if not exists policies_accepted boolean not null default false,
  add column if not exists accepted_at timestamptz,
  add column if not exists signature text;

-- payment_status enum-by-convention: 'unpaid' | 'pending_verify' | 'paid'
alter table public.party_bookings drop constraint if exists party_bookings_payment_status_chk;
alter table public.party_bookings add constraint party_bookings_payment_status_chk
  check (payment_status in ('unpaid', 'pending_verify', 'paid'));

-- payment_method-by-convention: null | 'stripe' | 'venmo'
alter table public.party_bookings drop constraint if exists party_bookings_payment_method_chk;
alter table public.party_bookings add constraint party_bookings_payment_method_chk
  check (payment_method is null or payment_method in ('stripe', 'venmo'));

-- One paid+approved party per calendar day per tenant. Partial unique index
-- on a generated date column (timezone-naive UTC truncation matches what the
-- Edge Function uses when checking for collisions).
create index if not exists party_bookings_starts_day_idx
  on public.party_bookings (tenant_id, ((starts_at at time zone 'UTC')::date))
  where status = 'approved' and payment_status = 'paid';

create unique index if not exists party_bookings_one_per_day_uniq
  on public.party_bookings (tenant_id, ((starts_at at time zone 'UTC')::date))
  where status = 'approved' and payment_status = 'paid';

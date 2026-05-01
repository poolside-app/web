-- =============================================================================
-- Stripe Connect + Google identity hooks
-- =============================================================================
-- Each tenant connects their own Stripe account via Standard Connect. We
-- store the resulting `acct_...` id and surface its onboarding state so
-- the admin UI can show "connect required" vs "ready to charge" pills.
-- We also remember the Google `sub` for any user who signs in with Google
-- so subsequent OAuth round-trips skip the email-match path.
-- =============================================================================

alter table public.tenants
  add column if not exists stripe_account_id     text,
  add column if not exists stripe_charges_enabled boolean not null default false,
  add column if not exists stripe_payouts_enabled boolean not null default false;

create index if not exists tenants_stripe_account_idx
  on public.tenants(stripe_account_id) where stripe_account_id is not null;

alter table public.admin_users
  add column if not exists google_sub text;

alter table public.household_members
  add column if not exists google_sub text;

create unique index if not exists admin_users_google_sub_idx
  on public.admin_users(google_sub) where google_sub is not null;
create unique index if not exists household_members_google_sub_idx
  on public.household_members(google_sub) where google_sub is not null;

-- Stripe session ids on the per-bookable surfaces so the webhook can
-- look up which row to flip on payment_intent.succeeded.
alter table public.program_bookings    add column if not exists stripe_session_id text;
alter table public.guest_pass_packs    add column if not exists stripe_session_id text;
alter table public.party_bookings      add column if not exists stripe_session_id text;

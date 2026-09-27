-- =============================================================================
-- discounts_and_referral_rewards — codes, prices that come off, and the
-- referral reward timeline (PLAN.md H5–H7, Doug 2026-09-26)
-- =============================================================================
-- H7  discount_codes: the board makes codes under Money (a code, $ or % off,
--     a last day, optionally how many families can use it). Early bird is
--     one of these now. A code can show on the member home.
--
-- H5  Each membership payment already runs through one applications row (new
--     family or renewal). The row now carries its price:
--       base_cents        the level's price when it was worked out
--       discount_cents    the ONE discount: a code or the referral discount,
--                         whichever saves more (discount_kind says which)
--       credit_cents      the family's referral credit used (renewals)
--       amount_due_cents  what card checkout, payment plans and Venmo ask for
--     A code use and a credit are only recorded once the payment clears
--     (discount_recorded_at). payment_reference holds the Venmo transaction
--     or check number, which the referral approval screen shows.
--
-- H6  referrals gain the 30-day wait (referee_paid_at, unlocks_at), the text
--     sent on unlock day, and 'void' for a reward whose new family's payment
--     was refunded or cancelled first. There were no referrals when this ran.
-- =============================================================================

create table if not exists public.discount_codes (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  code          text not null check (code = upper(code) and length(code) between 2 and 32),
  label         text,
  amount_cents  integer check (amount_cents > 0),
  percent_off   numeric(5,2) check (percent_off > 0 and percent_off <= 100),
  expires_on    date,                -- last day it works, in pool time; null = no end
  max_uses      integer check (max_uses > 0),   -- families; null = no limit
  show_on_home  boolean not null default false,
  active        boolean not null default true,
  created_by    uuid references public.admin_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, code),
  check ((amount_cents is null) <> (percent_off is null))
);
create index if not exists discount_codes_tenant_idx on public.discount_codes(tenant_id, active);
alter table public.discount_codes enable row level security;

alter table public.applications
  add column if not exists base_cents            integer,
  add column if not exists discount_cents        integer not null default 0,
  add column if not exists discount_kind         text check (discount_kind in ('code', 'referral')),
  add column if not exists discount_code_id      uuid references public.discount_codes(id) on delete set null,
  add column if not exists credit_cents          integer not null default 0,
  add column if not exists amount_due_cents      integer,
  add column if not exists discount_recorded_at  timestamptz,
  add column if not exists payment_reference     text;
create index if not exists applications_discount_code_idx
  on public.applications(discount_code_id) where discount_code_id is not null;

alter table public.referrals
  add column if not exists referee_paid_at   timestamptz,
  add column if not exists unlocks_at        timestamptz,
  add column if not exists unlock_texted_at  timestamptz,
  add column if not exists voided_at         timestamptz,
  add column if not exists void_reason       text;

alter table public.referrals drop constraint if exists referrals_status_check;
alter table public.referrals add constraint referrals_status_check
  check (status in ('applied', 'verified', 'claimed', 'rewarded', 'rejected', 'declined', 'void'));

-- The nightly unlock sweep: verified rewards whose wait is over.
create index if not exists referrals_unlock_idx
  on public.referrals(unlocks_at) where status = 'verified';

-- The reward is the club's setting now (settings.referrals.reward_cents), so
-- the old $100 column default only applies if a caller forgets to pass it.
comment on column public.referrals.reward_amount_cents is
  'The reward for this referral, from settings.referrals.reward_cents when the new family paid (default $100); lowered to what the cap allows on approval.';

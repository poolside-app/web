-- =============================================================================
-- referrals — member-driven growth: refer a new family, get $100 off your dues
-- =============================================================================
-- Two tables, one persistent identity per member, one row per actual referral
-- use. Plus a credit ledger column on households so the "next year's dues"
-- discount lands somewhere durable.
--
-- referral_codes — one per member, persistent. The shareable link is
--   <slug>.poolsideapp.com/apply.html?ref=MARGARET-X4F2
--
-- referrals — one row per application that came in via a code. Lifecycle:
--   applied → verified (payment cleared & eligibility passed) → rewarded
--   (member chose how to use the credit). Or applied → rejected if the
--   "new" applicant turns out to be a returning member.
--
-- households.referral_credits_cents — accumulator. When a referral is
--   verified AND the referrer chose 'next_year_discount', this column on
--   their household goes up by the reward amount. When dues are computed
--   next season, this gets subtracted.
-- =============================================================================

create table if not exists public.referral_codes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  member_id    uuid not null references public.household_members(id) on delete cascade,
  household_id uuid not null references public.households(id) on delete cascade,
  code         text not null,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (tenant_id, member_id),
  unique (code)
);
create index if not exists referral_codes_tenant_idx on public.referral_codes(tenant_id);

alter table public.referral_codes enable row level security;
drop policy if exists referral_codes_service_role on public.referral_codes;
create policy referral_codes_service_role on public.referral_codes
  for all to service_role using (true) with check (true);

create table if not exists public.referrals (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  referral_code_id    uuid not null references public.referral_codes(id) on delete cascade,
  application_id      uuid references public.applications(id) on delete set null,

  -- Snapshot of who applied with this code, in case the application gets
  -- deleted later (we still want the audit trail of "Margaret referred Sarah").
  applied_by_email    text,
  applied_by_family   text,
  applied_at          timestamptz not null default now(),

  -- Lifecycle:
  --   'applied'   — application submitted, code valid, no payment yet
  --   'verified'  — payment cleared AND eligibility check passed
  --                 (applicant's email/phone wasn't an existing/prior member)
  --   'rewarded'  — referrer chose how to use it; credit / refund task fired
  --   'rejected'  — failed eligibility (returning member) or admin rejection
  status              text not null default 'applied'
                      check (status in ('applied','verified','rewarded','rejected')),
  rejection_reason    text,

  -- Reward state. reward_type is set by the referrer once verified.
  reward_type         text check (reward_type in ('next_year_discount','current_year_refund')),
  reward_amount_cents int not null default 10000,
  reward_chosen_at    timestamptz,
  reward_applied_at   timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists referrals_tenant_status_idx
  on public.referrals(tenant_id, status, created_at desc);
create index if not exists referrals_code_idx
  on public.referrals(referral_code_id);
create index if not exists referrals_application_idx
  on public.referrals(application_id) where application_id is not null;

alter table public.referrals enable row level security;
drop policy if exists referrals_service_role on public.referrals;
create policy referrals_service_role on public.referrals
  for all to service_role using (true) with check (true);

-- Capture the code on the application itself so the apply→approve→verify
-- pipeline has the link to the referral row at every stage.
alter table public.applications
  add column if not exists referral_code text;

-- Accumulator on households: discount earned but not yet redeemed.
-- When dues for the next season are calculated, subtract this and zero it.
alter table public.households
  add column if not exists referral_credits_cents integer not null default 0;

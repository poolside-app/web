-- =============================================================================
-- Poolside — initial schema (multi-tenant foundation)
-- =============================================================================
-- This migration lays down the tables every feature depends on:
--   1. tenants            — the directory of pool clubs using Poolside
--   2. provider_admins    — that's you, Doug — the SaaS provider
--   3. admin_roles        — role catalog (per-tenant admin roles)
--   4. admin_users        — per-tenant admins (treasurer, board members)
--   5. admin_user_roles   — many-to-many bridge
--   6. app_secrets        — per-tenant encrypted-at-rest secrets (Twilio,
--                           Resend, Drive refresh tokens, etc.)
--   7. settings           — per-tenant config blob
--   8. households         — the billing entity (one per family)
--   9. household_members  — the people inside (with phones)
--  10. member_sessions    — SMS-auth session tokens
--
-- Domain features (campaigns, swim programs, parties, snack shack, etc.)
-- land in subsequent migrations once we start building each.
--
-- All tenant-scoped tables get `tenant_id uuid not null references tenants(id)`
-- and RLS policies that key off the JWT's tenant_id claim. Edge Functions
-- bypass RLS via service role.
-- =============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- 1. tenants
-- ──────────────────────────────────────────────────────────────────────────

create table public.tenants (
  id              uuid primary key default gen_random_uuid(),
  slug            text unique not null
                  check (slug ~ '^[a-z0-9][a-z0-9-]{1,29}$'),
  display_name    text not null,
  custom_domain   text unique,                       -- premium tier
  status          text not null default 'trial',
                  -- 'trial' | 'active' | 'suspended' | 'churned'
  plan            text not null default 'free',
                  -- 'free' | 'starter' | 'pro' | 'enterprise'
  trial_ends_at   timestamptz default (now() + interval '14 days'),
  stripe_customer_id text,
  notes           text,                              -- provider-internal
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create index tenants_slug_idx     on public.tenants(slug);
create index tenants_status_idx   on public.tenants(status);
create index tenants_custom_domain_idx on public.tenants(custom_domain) where custom_domain is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- 2. provider_admins (Doug + future Poolside team)
--    Distinct from tenant admins — these have cross-tenant powers.
-- ──────────────────────────────────────────────────────────────────────────

create table public.provider_admins (
  id              uuid primary key default gen_random_uuid(),
  email           text unique not null,
  password_hash   text not null,                     -- bcrypt
  display_name    text,
  is_super        boolean not null default false,    -- true = root, can do anything
  is_default_pw   boolean not null default true,     -- forces password change on first login
  active          boolean not null default true,
  last_login_at   timestamptz,
  created_at      timestamptz default now()
);

-- ──────────────────────────────────────────────────────────────────────────
-- 3. admin_roles (catalog of tenant-admin roles)
--    Tenants can use these built-ins or define their own custom roles later.
-- ──────────────────────────────────────────────────────────────────────────

create table public.admin_roles (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid references public.tenants(id) on delete cascade,
                  -- null = system default role available to every tenant
  slug            text not null,
                  -- 'super-admin' | 'treasurer' | 'membership' | 'gate' | 'photos' | etc.
  name            text not null,
  emoji           text,
  color           text,
  catches_events  text[] default '{}',
                  -- which alert events this role gets emailed/SMS-ed about
  tab_access      text[] default '{}',
                  -- which admin tabs they can see ('operations', 'content', 'settings')
  is_system       boolean not null default false,    -- can't be edited by tenant
  created_at      timestamptz default now(),
  unique (tenant_id, slug)
);

-- Seed system roles (tenant_id = null means available to all tenants)
insert into public.admin_roles (tenant_id, slug, name, emoji, tab_access, is_system) values
  (null, 'super-admin',    'Super Admin',          '👑', '{operations,content,settings,onboarding}', true),
  (null, 'treasurer',      'Treasurer',            '💰', '{operations,settings}',                    true),
  (null, 'membership',     'Membership Lead',      '🏠', '{operations}',                             true),
  (null, 'communications', 'Communications',       '📢', '{content,operations}',                     true),
  (null, 'parties',        'Party Coordinator',    '🎉', '{operations}',                             true),
  (null, 'gate',           'Gate / Security',      '🚪', '{operations}',                             true);

-- ──────────────────────────────────────────────────────────────────────────
-- 4. admin_users (per-tenant admins — board members)
-- ──────────────────────────────────────────────────────────────────────────

create table public.admin_users (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  username        text not null,                     -- email-shaped or short handle
  email           text,                              -- for notifications
  password_hash   text not null,                     -- bcrypt
  display_name    text,
  notify_pref     text default 'email',              -- 'email' | 'sms' | 'both' | 'none'
  is_super        boolean not null default false,    -- super within their tenant
  is_default_pw   boolean not null default true,
  active          boolean not null default true,
  last_login_at   timestamptz,
  created_at      timestamptz default now(),
  unique (tenant_id, username)
);

create index admin_users_tenant_idx on public.admin_users(tenant_id);

-- ──────────────────────────────────────────────────────────────────────────
-- 5. admin_user_roles (m:n bridge — admin can have multiple roles)
-- ──────────────────────────────────────────────────────────────────────────

create table public.admin_user_roles (
  admin_user_id   uuid not null references public.admin_users(id) on delete cascade,
  admin_role_id  uuid not null references public.admin_roles(id) on delete cascade,
  primary key (admin_user_id, admin_role_id)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 6. app_secrets (per-tenant integration credentials)
-- ──────────────────────────────────────────────────────────────────────────

create table public.app_secrets (
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  key             text not null,
  value           text not null,
  updated_at      timestamptz default now(),
  updated_by      uuid references public.admin_users(id),
  primary key (tenant_id, key)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 7. settings (per-tenant config blob)
--    JSONB lets us add config keys without migrations.
-- ──────────────────────────────────────────────────────────────────────────

create table public.settings (
  tenant_id       uuid primary key references public.tenants(id) on delete cascade,
  value           jsonb not null default '{}'::jsonb,
  updated_at      timestamptz default now(),
  updated_by      uuid references public.admin_users(id)
);

-- ──────────────────────────────────────────────────────────────────────────
-- 8. households + 9. household_members (the core member data model)
--    Lifted from Bishop Estates' R7 schema, with tenant_id added.
-- ──────────────────────────────────────────────────────────────────────────

create table public.households (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  family_name         text not null,
  tier                text not null default 'family',  -- matches pricing.id
  fob_number          text,
  dues_paid_for_year  boolean not null default false,
  paid_until_year     int,
  address             text,
  city                text,
  zip                 text,
  emergency_contact   text,
  notes               text,
  active              boolean not null default true,
  created_at          timestamptz default now()
);

-- A fob can only be assigned to one household within a tenant.
create unique index households_tenant_fob_unique
  on public.households(tenant_id, fob_number)
  where fob_number is not null;
create index households_tenant_idx       on public.households(tenant_id);
create index households_active_idx       on public.households(tenant_id, active);
create index households_family_name_idx  on public.households(tenant_id, family_name);

create table public.household_members (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  household_id        uuid not null references public.households(id) on delete cascade,
  name                text not null,
  phone_e164          text,
  email               text,
  role                text not null check (role in ('primary','adult','teen','child')),
  can_unlock_gate     boolean not null default true,
  can_book_parties    boolean not null default false,
  active              boolean not null default true,
  added_by            uuid references public.household_members(id),
  confirmed_at        timestamptz,                    -- null until first sign-in
  last_seen_at        timestamptz,
  created_at          timestamptz default now()
);

-- A phone can be on at most one ACTIVE member at a time, scoped to tenant.
create unique index hm_tenant_phone_active_unique
  on public.household_members(tenant_id, phone_e164)
  where phone_e164 is not null and active = true;
create index hm_household_idx on public.household_members(household_id);
create index hm_tenant_idx    on public.household_members(tenant_id);

-- Cap: max 8 active members per household (cross-tenant safe — checks within
-- the household, which is itself tenant-scoped via FK).
create or replace function public.fn_household_member_cap() returns trigger as $$
declare cnt int;
begin
  if new.active then
    select count(*) into cnt
      from public.household_members
     where household_id = new.household_id
       and active = true
       and id <> coalesce(new.id, '00000000-0000-0000-0000-000000000000'::uuid);
    if cnt >= 8 then
      raise exception 'household_member_cap: max 8 active members per household';
    end if;
  end if;
  return new;
end $$ language plpgsql;

create trigger trg_household_member_cap
  before insert or update of active, household_id on public.household_members
  for each row execute function public.fn_household_member_cap();

-- ──────────────────────────────────────────────────────────────────────────
-- 10. member_sessions (SMS-auth tokens)
-- ──────────────────────────────────────────────────────────────────────────

create table public.member_sessions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  member_id       uuid not null references public.household_members(id) on delete cascade,
  token_hash      text not null,                     -- bcrypt of the raw token
  issued_at       timestamptz default now(),
  expires_at      timestamptz not null,
  user_agent      text,
  ip              inet,
  revoked_at      timestamptz
);

create index member_sessions_tenant_idx on public.member_sessions(tenant_id);
create index member_sessions_member_idx on public.member_sessions(member_id);
create index member_sessions_token_hash_idx on public.member_sessions(token_hash) where revoked_at is null;

-- ──────────────────────────────────────────────────────────────────────────
-- RLS — every tenant table is locked down by default.
--   Edge Functions use the service role and bypass RLS.
--   Browser-facing reads/writes go through Edge Functions, so the anon
--   policies below are intentionally absent (no public access).
-- ──────────────────────────────────────────────────────────────────────────

alter table public.tenants            enable row level security;
alter table public.provider_admins    enable row level security;
alter table public.admin_roles        enable row level security;
alter table public.admin_users        enable row level security;
alter table public.admin_user_roles   enable row level security;
alter table public.app_secrets        enable row level security;
alter table public.settings           enable row level security;
alter table public.households         enable row level security;
alter table public.household_members  enable row level security;
alter table public.member_sessions    enable row level security;

-- No policies = anon/authenticated roles see nothing. Service role bypasses.

-- ──────────────────────────────────────────────────────────────────────────
-- updated_at maintenance trigger
-- ──────────────────────────────────────────────────────────────────────────

create or replace function public.fn_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

create trigger trg_tenants_updated_at  before update on public.tenants
  for each row execute function public.fn_set_updated_at();
create trigger trg_settings_updated_at before update on public.settings
  for each row execute function public.fn_set_updated_at();

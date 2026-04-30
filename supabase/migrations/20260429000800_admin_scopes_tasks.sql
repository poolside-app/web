-- =============================================================================
-- admin_users.scopes + admin_tasks
-- =============================================================================
-- Volunteer pool boards rotate. Treasurer + Membership Chair + Marketing
-- all need their own login, but they shouldn't see every tab — too much
-- noise, and a wider blast radius if any one account is compromised.
--
-- This adds:
--   1. Per-admin `scopes` (which feature areas they can manage) and a
--      `role_template` for the named role they were assigned.
--   2. `phone_e164` for future SMS magic-link login (Twilio TBD).
--   3. `admin_tasks` — a queue of "this needs attention" entries that
--      target one or more scopes. Anyone with a matching scope sees them
--      on their dashboard; the first admin to handle one closes it.
-- =============================================================================

alter table public.admin_users
  add column if not exists scopes text[] not null default '{}',
  add column if not exists role_template text not null default 'owner',
  add column if not exists phone_e164 text;

-- Existing admins get full access. Empty/legacy rows get `owner`.
update public.admin_users
  set role_template = 'owner'
  where role_template is null or role_template = '';

create table if not exists public.admin_tasks (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  target_scopes text[] not null default '{}',           -- which scopes can see this; empty = owners only
  kind          text not null,                          -- 'application.submitted' | 'venmo.claim' | etc.
  summary       text not null,
  link_url      text,
  source_kind   text,
  source_id     uuid,
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  completed_at  timestamptz,
  completed_by  uuid references public.admin_users(id) on delete set null,
  dismissed_at  timestamptz
);

-- Open tasks for a scope = the index that powers the dashboard panel
create index if not exists admin_tasks_open_idx
  on public.admin_tasks(tenant_id, created_at desc)
  where completed_at is null and dismissed_at is null;

-- Lookup by source so we can dedupe "new app for THIS application id"
create index if not exists admin_tasks_source_idx
  on public.admin_tasks(source_kind, source_id)
  where completed_at is null and dismissed_at is null;

alter table public.admin_tasks enable row level security;
drop policy if exists admin_tasks_service_role on public.admin_tasks;
create policy admin_tasks_service_role on public.admin_tasks for all using (true) with check (true);

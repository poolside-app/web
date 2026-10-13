-- PLAN.md AS4: putting Poolside's keyfobs on the doors, "check first, then
-- send" (Doug, 10/13). A check job has the gate computer read what the
-- controllers hold for the fobs Poolside manages; Poolside works out the
-- changes (_shared/keyfob_sync.ts); a send job writes exactly those and
-- reads them back. Cards Poolside doesn't manage are never touched.
--
-- The nightly check-and-send runs only for clubs whose "Auto keyfob
-- activations" switch is on (provider admin, Overrides). Off by default.

create table if not exists public.keyfob_syncs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('check', 'send')),
  status text not null default 'pending' check (status in ('pending', 'in_flight', 'done', 'failed')),
  auto boolean not null default false,
  requested_by uuid references public.admin_users(id) on delete set null,
  check_id uuid references public.keyfob_syncs(id) on delete set null,   -- a send follows a check
  plan jsonb not null,            -- check: what to read (and want); send: the writes
  result jsonb,                   -- check: what was read, the writes, a summary; send: what's live
  error text,
  created_at timestamptz not null default now(),
  picked_up_at timestamptz,
  completed_at timestamptz
);
create index if not exists keyfob_syncs_tenant on public.keyfob_syncs (tenant_id, status, created_at);
alter table public.keyfob_syncs enable row level security;

alter table public.tenants
  add column if not exists auto_keyfob_sync boolean not null default false;

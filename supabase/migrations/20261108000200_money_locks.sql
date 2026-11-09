-- PLAN.md CQ (Doug 11/8): locks on where the money goes and who can change
-- the board. A fresh texted code before a dangerous change, and a second
-- board member's approval for some of them.

-- A one-time code for one change (CQ1). Only its sha256 is kept.
create table if not exists public.admin_step_up_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  purpose text not null,
  code_hash text not null,
  sent_via text,
  expires_at timestamptz not null,
  used_at timestamptz,
  attempts integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists admin_step_up_codes_admin on public.admin_step_up_codes (admin_user_id, purpose, created_at desc);
alter table public.admin_step_up_codes enable row level security;

-- A change waiting for a second board member (CQ3): switching Stripe
-- accounts, changing the Venmo handle, giving someone full access.
create table if not exists public.pending_changes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('stripe_switch', 'payments_change', 'full_access')),
  target_admin_id uuid references public.admin_users(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  summary text not null,
  requested_by uuid references public.admin_users(id) on delete set null,
  status text not null default 'waiting' check (status in ('waiting', 'approved', 'stopped', 'expired', 'cancelled')),
  decided_by uuid references public.admin_users(id) on delete set null,
  decided_by_poolside boolean not null default false,
  decided_at timestamptz,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz not null default now()
);
create index if not exists pending_changes_waiting on public.pending_changes (tenant_id, status, created_at desc);
alter table public.pending_changes enable row level security;

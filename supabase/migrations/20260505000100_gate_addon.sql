-- =============================================================================
-- gate_addon — paid keyfob/gate-unlock integration
-- =============================================================================
-- Architecture: cloud queues unlock commands; a Pi bridge sitting on the
-- club's LAN polls the cloud every 1-2 seconds and translates commands into
-- panel-specific HTTP calls. The cloud never reaches the panel directly
-- (panels live behind club routers on private IPs).
--
-- Two tables:
--   gate_panels   — one row per tenant. Lifecycle + config + bridge identity.
--   gate_unlocks  — every unlock request (the queue + permanent audit log).
--
-- Panel password storage: plaintext-in-DB for v1. Defensible because (a) RLS
-- restricts to service_role, (b) even if leaked, the attacker would also
-- need to be on the club's LAN to use it, (c) a club-network attacker could
-- reach the panel directly anyway. Revisit at 5+ clubs with a per-tenant
-- pgcrypto key or push to bridge-only storage.
-- =============================================================================

create table if not exists public.gate_panels (
  id                          uuid primary key default gen_random_uuid(),
  tenant_id                   uuid not null unique references public.tenants(id) on delete cascade,

  -- Lifecycle. Provider flips status; tenants can only request.
  status                      text not null default 'requested'
                              check (status in ('requested', 'invoiced', 'shipping', 'active', 'suspended', 'cancelled')),
  requested_at                timestamptz not null default now(),
  activated_at                timestamptz,

  -- Panel config. Filled by admin during setup. Until panel_host is set
  -- the bridge has nothing to talk to, so unlock attempts return a clear
  -- "panel not configured yet" error.
  panel_type                  text check (panel_type in ('mengqi_hxc7000', 'unknown', 'custom')) default 'unknown',
  panel_host                  text,
  panel_admin_user            text,
  panel_admin_password        text,                                 -- plaintext for v1; service_role only

  -- Bridge identity. bridge_secret is generated at provisioning, hashed
  -- here, plaintext returned ONCE in the activation email.
  bridge_id                   uuid not null default gen_random_uuid(),
  bridge_secret_hash          text,                                 -- sha256 of plaintext
  bridge_last_seen_at         timestamptz,
  bridge_version              text,

  -- Internal notes for the platform owner (invoicing state, install date, etc.)
  notes                       text,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create index if not exists gate_panels_status_idx on public.gate_panels(status);
create index if not exists gate_panels_bridge_id_idx on public.gate_panels(bridge_id);

alter table public.gate_panels enable row level security;
drop policy if exists gate_panels_service_role on public.gate_panels;
create policy gate_panels_service_role on public.gate_panels
  for all to service_role using (true) with check (true);

-- ── unlocks: queue + permanent audit ──────────────────────────────────────
create table if not exists public.gate_unlocks (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants(id) on delete cascade,
  member_id           uuid references public.household_members(id) on delete set null,

  -- Queue state. pending → in_flight (bridge picked up) → done/failed/timeout.
  -- A 30-second cron will mark stale in_flight rows as 'timeout'.
  status              text not null default 'pending'
                      check (status in ('pending', 'in_flight', 'done', 'failed', 'timeout')),
  requested_at        timestamptz not null default now(),
  picked_up_at        timestamptz,
  completed_at        timestamptz,

  -- What happened. result_code is machine-readable; result_detail is for
  -- ops / admin display.
  result_code         text,                                  -- 'ok' | 'panel_unreachable' | 'auth_failed' | 'bridge_offline' | 'rate_limited'
  result_detail       text,

  -- Diagnostics (member's request side)
  client_ip           text,
  client_user_agent   text,

  -- Diagnostics (bridge side)
  bridge_id           uuid,

  -- For testing: super-admin can fire unlocks that bypass the dues-paid /
  -- can_unlock_gate checks. Logged so we can audit "who tested when."
  is_test             boolean not null default false,
  actor_kind          text default 'member' check (actor_kind in ('member', 'admin_test', 'system'))
);

-- Hot path: the bridge poll asks "any pending for my tenant?"
create index if not exists gate_unlocks_pending_idx
  on public.gate_unlocks(tenant_id, status, requested_at)
  where status in ('pending', 'in_flight');

-- Audit query: "show me last 30 days of unlocks for this tenant"
create index if not exists gate_unlocks_audit_idx
  on public.gate_unlocks(tenant_id, requested_at desc);

-- Member rate limit: how many unlocks did this member request in last N seconds
create index if not exists gate_unlocks_member_recent_idx
  on public.gate_unlocks(member_id, requested_at desc)
  where member_id is not null;

alter table public.gate_unlocks enable row level security;
drop policy if exists gate_unlocks_service_role on public.gate_unlocks;
create policy gate_unlocks_service_role on public.gate_unlocks
  for all to service_role using (true) with check (true);

-- Pre-seed Bishop Estates as 'active' (grandfathered free per pricing memory).
-- panel_type stays 'unknown' until super-admin or tenant fills in panel_host
-- + creds. The bridge_id is real; the bridge_secret_hash is a placeholder
-- that the provider page rotates with the real one when shipping the bridge.
insert into public.gate_panels (tenant_id, status, panel_type, activated_at, notes)
select t.id, 'active', 'mengqi_hxc7000', now(), 'Grandfathered free — original Bishop Estates pilot install. Pi already on-site running BE single-tenant code; will be re-pointed at Poolside cloud once bridge software ships.'
from public.tenants t
where t.slug = 'bishopestates'
on conflict (tenant_id) do nothing;

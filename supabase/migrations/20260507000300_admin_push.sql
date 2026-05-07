-- =============================================================================
-- 20260507000300 — admin_push_subscriptions
-- =============================================================================
-- Web Push subscriptions for admin PWA notifications. Only board members
-- (admins) opt in; we never push to public/member surfaces.
--
-- Each row is one (admin × browser) pair. Same admin on two devices = two
-- rows. Endpoint is the push service URL (FCM / Mozilla / Apple). Keys
-- p256dh + auth are the per-subscription public key + secret used to
-- encrypt the message payload.
--
-- Cleanup: when a push send returns 404/410 from the push service, the
-- subscription is dead — push_admin deletes the row.
-- =============================================================================

create table if not exists public.admin_push_subscriptions (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  admin_user_id   uuid not null references public.admin_users(id) on delete cascade,
  endpoint        text not null,
  p256dh          text not null,
  auth            text not null,
  user_agent      text,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  -- Same admin can subscribe from multiple devices; unique on (admin, endpoint)
  unique (admin_user_id, endpoint)
);

create index if not exists idx_admin_push_tenant_admin
  on public.admin_push_subscriptions (tenant_id, admin_user_id);

-- RLS: edge functions use service role, never client; lock down direct
-- access so a leaked anon key can't enumerate subscriptions.
alter table public.admin_push_subscriptions enable row level security;
-- (No policies = nobody at the API layer can read/write. Service role bypasses RLS.)

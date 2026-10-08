-- Member pop-up notifications (PLAN.md N6, Doug 2026-10-07).
-- Members turn on notifications in the app, like the board already can.
-- Board replies, party decisions, plan receipts and announcements reach
-- them by pop-up; texts are only for "Text all members", sign-in codes and
-- the welcome text.

create table if not exists public.member_push_subscriptions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  member_id     uuid not null references public.household_members(id) on delete cascade,
  household_id  uuid references public.households(id) on delete cascade,
  endpoint      text not null,
  p256dh        text not null,
  auth          text not null,
  user_agent    text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (member_id, endpoint)
);
create index if not exists member_push_tenant_member_idx on public.member_push_subscriptions (tenant_id, member_id);
create index if not exists member_push_household_idx on public.member_push_subscriptions (household_id);
-- Nothing reaches Postgres except the Edge Functions (service role).
alter table public.member_push_subscriptions enable row level security;

-- Announcements: a "Notify members" switch on each post, on by default.
-- notified_at keeps an edit from sending the pop-up twice.
alter table public.posts
  add column if not exists notify_members boolean not null default true,
  add column if not exists notified_at timestamptz;

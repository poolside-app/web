-- =============================================================================
-- email_queue + email_log — spread a bulk send across days
-- =============================================================================
-- Resend's free tier allows 3,000 emails a month but only 100 a day. Bishop
-- has ~150 households, so the single most important email the club will ever
-- send — "here is your login, the season starts" — stops dead at 100 and the
-- remaining 50 families never hear anything. Nothing errors; the blast just
-- reports fewer sends than there are households, and nobody notices until a
-- neighbour asks why they were left out.
--
-- So bulk mail is queued rather than sent, and the daily cron drains it inside
-- a budget. A 150-household invite goes out over two mornings on its own.
--
-- Transactional mail — sign-in links, receipts, approvals — is NOT queued. A
-- member waiting on a login code cannot wait until 14:00 UTC tomorrow. Those
-- still send immediately, but they are logged, because they spend the same
-- daily allowance and the budget has to know about them.
-- =============================================================================

-- ── every send, so the budget can be computed ──────────────────────────────
create table if not exists public.email_log (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid references public.tenants(id) on delete cascade,
  to_email   text not null,
  category   text not null default 'transactional',
  success    boolean not null default true,
  error      text,
  source     text,
  sent_at    timestamptz not null default now()
);

-- The budget query is "how many went out today", so date-first.
create index if not exists email_log_sent_idx on public.email_log (sent_at desc);
create index if not exists email_log_tenant_idx on public.email_log (tenant_id, sent_at desc);

alter table public.email_log enable row level security;
drop policy if exists email_log_service_role on public.email_log;
create policy email_log_service_role on public.email_log
  for all to service_role using (true) with check (true);

-- ── the queue itself ───────────────────────────────────────────────────────
create table if not exists public.email_queue (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,

  to_email    text not null,
  subject     text not null,
  html        text not null,
  reply_to    text,
  category    text not null default 'bulk',

  status      text not null default 'queued',
  attempts    int  not null default 0,
  last_error  text,

  -- Set by the enqueuer when something must not go out before a date.
  not_before  timestamptz,

  created_at  timestamptz not null default now(),
  sent_at     timestamptz
);

alter table public.email_queue
  drop constraint if exists email_queue_status_known;
alter table public.email_queue
  add constraint email_queue_status_known
  check (status in ('queued', 'sent', 'failed', 'cancelled'));

-- The drain reads exactly this: oldest queued first, respecting not_before.
create index if not exists email_queue_drain_idx
  on public.email_queue (status, created_at)
  where status = 'queued';
create index if not exists email_queue_tenant_idx
  on public.email_queue (tenant_id, created_at desc);

-- Four attempts and it stops. A permanently bouncing address must not be able
-- to consume the whole club's daily allowance every morning forever.
alter table public.email_queue
  drop constraint if exists email_queue_attempts_sane;
alter table public.email_queue
  add constraint email_queue_attempts_sane
  check (attempts >= 0 and attempts <= 10);

alter table public.email_queue enable row level security;
drop policy if exists email_queue_service_role on public.email_queue;
create policy email_queue_service_role on public.email_queue
  for all to service_role using (true) with check (true);

comment on table public.email_queue is
  'Bulk email waiting for daily-budget headroom. Transactional mail never lands here — see the migration header.';

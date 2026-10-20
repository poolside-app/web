-- PLAN.md BG2 (10/20 audit): texts the platform's daily limit stopped wait
-- here and go on the next daily run (payment_plans cron, drainSmsQueue in
-- _shared/send_sms.ts), instead of being skipped. Only the server functions
-- read or write it.
create table if not exists public.sms_queue (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  to_phone    text not null,
  body        text not null,
  kind        text not null default 'campaign',
  source      text,
  not_before  timestamptz not null default now(),
  attempts    int not null default 0,
  last_error  text,
  sent_at     timestamptz,
  failed_at   timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists sms_queue_waiting on public.sms_queue (created_at) where sent_at is null and failed_at is null;
alter table public.sms_queue enable row level security;

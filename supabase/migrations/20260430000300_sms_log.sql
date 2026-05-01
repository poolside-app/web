-- =============================================================================
-- sms_log — per-tenant SMS audit trail + cap enforcement source
-- =============================================================================
-- Every Twilio send (auth, transactional, campaign, reminder) writes one row.
-- Monthly caps are computed by counting rows where category != 'auth' for
-- the current calendar month (UTC).
--
-- Categories:
--   'auth'         — sign-in magic links (NEVER capped — would brick the app)
--   'transactional'— password resets, receipts (uncapped)
--   'campaign'     — admin-triggered blast (capped per plan)
--   'reminder'     — automated nudges (capped per plan)
--
-- Plan caps live in code (helpers/sms_cap.ts), not in this table.
-- =============================================================================

create table if not exists public.sms_log (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  category    text not null check (category in ('auth','transactional','campaign','reminder')),
  to_phone    text not null,
  success     boolean not null default true,
  error       text,
  source      text,                                       -- e.g. 'renewals.send_blast'
  sent_at     timestamptz not null default now()
);

-- Hot path query: count(*) per tenant for current month, filtered by category.
-- date_trunc index supports the monthly aggregate without scanning the table.
create index if not exists sms_log_tenant_month_idx
  on public.sms_log (tenant_id, sent_at desc);
create index if not exists sms_log_tenant_category_month_idx
  on public.sms_log (tenant_id, category, sent_at desc);

alter table public.sms_log enable row level security;
drop policy if exists sms_log_service on public.sms_log;
create policy sms_log_service on public.sms_log for all using (true) with check (true);

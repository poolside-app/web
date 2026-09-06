-- =============================================================================
-- auto-renew charging + season-aware enforcement
-- =============================================================================
-- Two problems, both about time.
--
-- 1. Auto-renew had a checkbox and nothing behind it. Charging a saved card
--    months later needs somewhere to keep the card, a record of the warning we
--    promised to send first, and somewhere for a failure to be visible to a
--    treasurer instead of vanishing into a cron log.
--
-- 2. Lapsing a plan deactivated keyfobs immediately. Across a Dec–July
--    schedule that is wrong twice over: in January it punishes nobody (the
--    pool is shut) and by June it turns a family away at the gate over a card
--    that expired six months earlier. Consequences should land when the season
--    is actually underway, so a lapse now records itself and waits.
-- =============================================================================

alter table public.households
  add column if not exists auto_renew_notice_year     int,
  add column if not exists auto_renew_notice_sent_at  timestamptz,
  add column if not exists auto_renew_last_attempt_at timestamptz,
  add column if not exists auto_renew_last_error      text;

comment on column public.households.auto_renew_notice_year is
  'Season we have already warned this household we are about to auto-charge for. Stops a second notice.';
comment on column public.households.auto_renew_last_error is
  'Why the most recent auto-renew charge failed, so a treasurer can see it without reading cron logs.';

-- Which households the auto-renew cron has to look at, without scanning every
-- household in every club.
create index if not exists households_auto_renew_idx
  on public.households (tenant_id, auto_renew, paid_until_year)
  where active and auto_renew;

alter table public.payment_plans
  add column if not exists enforced_at timestamptz;

comment on column public.payment_plans.enforced_at is
  'When a lapsed plan actually cost the household access. Null while lapsed but still pre-season.';

-- The enforcement sweep: lapsed plans still waiting for their season to start.
create index if not exists payment_plans_pending_enforcement_idx
  on public.payment_plans (tenant_id, status)
  where status = 'lapsed' and enforced_at is null;

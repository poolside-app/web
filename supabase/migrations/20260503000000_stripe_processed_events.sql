-- =============================================================================
-- stripe_processed_events — webhook idempotency ledger
-- =============================================================================
-- Stripe retries on any non-2xx response and occasionally re-fires events
-- that already returned 2xx. Without idempotency, a duplicate
-- checkout.session.completed re-fires every side effect: re-emails the
-- welcome message, double-flips household paid status, reopens admin tasks.
--
-- The webhook handler INSERTs into this table at the START of processing.
-- ON CONFLICT (id) DO NOTHING — if the event id already exists, return
-- early without doing any side-effect work.
--
-- Append-only by design. Old rows can be pruned after ~60 days
-- (Stripe's max retry window) by a future cron.
-- =============================================================================

create table if not exists public.stripe_processed_events (
  id            text primary key,                    -- Stripe event.id (evt_…)
  event_type    text not null,                       -- e.g. checkout.session.completed
  tenant_id     uuid references public.tenants(id) on delete set null,
  processed_at  timestamptz not null default now()
);

create index if not exists stripe_processed_events_processed_at_idx
  on public.stripe_processed_events(processed_at desc);

alter table public.stripe_processed_events enable row level security;
drop policy if exists stripe_processed_events_service_role on public.stripe_processed_events;
create policy stripe_processed_events_service_role
  on public.stripe_processed_events
  for all
  to service_role
  using (true)
  with check (true);

-- =============================================================================
-- applications.stripe_payment_intent_id — used by refund/dispute handlers
-- =============================================================================
-- The Checkout Session ID alone isn't enough to match charge events back to
-- an application: refund/dispute events arrive with charge.payment_intent
-- but no session reference. Storing the PI directly on the application row
-- gives us a fast lookup path in the webhook handler.
-- =============================================================================
alter table public.applications
  add column if not exists stripe_payment_intent_id text,
  add column if not exists refunded_at timestamptz,
  add column if not exists disputed_at timestamptz;
create index if not exists applications_stripe_pi_idx
  on public.applications(stripe_payment_intent_id) where stripe_payment_intent_id is not null;

-- Last off-session retry attempt timestamp on plan installments. Used by
-- payment_intent.payment_failed handler + dunning surfaces in the admin UI.
alter table public.payment_plan_installments
  add column if not exists last_attempt_at timestamptz;

-- =============================================================================
-- donations — fundraiser contributions, Stripe + manual entry
-- =============================================================================
-- Tracks every contribution toward a club's fundraiser. Two ingest paths:
--   - Stripe: donor pays via the club's Stripe Connect account; the webhook
--     inserts a verified row automatically.
--   - Manual: admin records a Venmo/cash/check donation by hand.
--
-- The fundraiser thermometer's "raised so far" is now derived from
-- SUM(amount_cents) WHERE status='verified' instead of being maintained
-- manually — admins still see the field in Settings but it's read-only-ish
-- (we recompute on insert/update/delete).
-- =============================================================================

create table if not exists public.donations (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  amount_cents    int not null check (amount_cents > 0),

  -- Donor profile. Names + messages render publicly when is_public=true
  -- and is_anonymous=false. Email is private (used for receipts + dedup
  -- when surfacing top supporters).
  donor_name      text,
  donor_email     text,
  message         text,

  method          text not null
                  check (method in ('stripe','venmo','paypal','cash','check','other')),
  is_public       boolean not null default true,
  is_anonymous    boolean not null default false,

  -- Lifecycle. Stripe webhook lands rows as 'verified'. Manual entries
  -- start 'verified' too (admin asserts they have the cash). 'pending'
  -- exists for future async flows (e.g. ACH). 'refunded' rolls the
  -- thermometer total back without deleting the audit row.
  status          text not null default 'verified'
                  check (status in ('verified','pending','refunded')),

  stripe_session_id      text unique,
  stripe_payment_intent  text,

  recorded_by     uuid references public.admin_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  verified_at     timestamptz default now()
);

create index if not exists donations_tenant_created_idx
  on public.donations(tenant_id, created_at desc);
create index if not exists donations_tenant_amount_idx
  on public.donations(tenant_id, amount_cents desc)
  where status = 'verified' and is_public = true;

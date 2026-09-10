-- =============================================================================
-- platform_fee_waiver — take nothing from a club, on purpose
-- =============================================================================
-- Bishop Estates is tenant zero and the founder sits on its board, so Poolside
-- billing it 1% of its own dues is a conflict of interest that belongs nowhere
-- near an annual meeting. This makes "we take nothing from this club" a
-- first-class, auditable state instead of something achieved by not connecting
-- Stripe — which would have cost Bishop payment plans, auto-renew and instant
-- approval, i.e. most of the product.
--
-- Scope. The waiver covers every PLATFORM TRANSACTION fee:
--   · 1% dues — applications, renewals, each installment, reactivation
--   · 1.5% programs, parties, guest passes
--   · the $4/payment plan fee, which is charged to the MEMBER, not the club
--
-- That last one is the point for Bishop: without it, the founder's neighbours
-- would each be paying him $16 for the privilege of spreading their dues.
--
-- It deliberately does NOT touch the subscription. Comping that is what
-- `plan`, `status` and plan_label_override already do.
--
-- A reason is required by the database, not merely by the UI. The realistic
-- failure here is not a misclick — it is a waiver granted for a pilot and
-- then forgotten for two years, silently, because nothing errors when money
-- stops arriving. A reason recorded at the moment of the decision is the only
-- artifact that survives that.
-- =============================================================================

alter table public.tenants
  add column if not exists platform_fees_waived        boolean not null default false,
  add column if not exists platform_fees_waived_reason text,
  add column if not exists platform_fees_waived_at     timestamptz,
  add column if not exists platform_fees_waived_by     uuid;

-- Every existing row defaults to false and so already satisfies this; no
-- NOT VALID needed, and it should be enforced from the first write.
alter table public.tenants
  drop constraint if exists tenants_fee_waiver_needs_reason;
alter table public.tenants
  add constraint tenants_fee_waiver_needs_reason
  check (
    not platform_fees_waived
    or (platform_fees_waived_reason is not null
        and length(btrim(platform_fees_waived_reason)) > 0)
  );

-- Small and highly selective — the provider list paints a badge from this and
-- should never scan the table to find two rows.
create index if not exists tenants_fees_waived_idx
  on public.tenants (id) where platform_fees_waived;

comment on column public.tenants.platform_fees_waived is
  'Take no platform transaction fee from this club — dues, programs, parties, guest passes, and the member-paid payment-plan fee. Does not affect their subscription.';

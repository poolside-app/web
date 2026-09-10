-- =============================================================================
-- payment_authorizations — evidence that a member agreed to the charge
-- =============================================================================
-- Poolside saves a card during a one-off Stripe payment and then charges it
-- off-session later: the second instalment of a plan, next season's dues under
-- auto-renew. Stripe writes mandate text automatically for ACH and SEPA but
-- not for cards saved this way — that disclosure is the merchant's, and their
-- requirement is that the member agreed to us initiating payments, and was
-- told the timing, how the amount is decided, and how to cancel.
--
-- Before this table, the entire record of that agreement was a boolean:
-- applications.wants_auto_renew. A family disputing a charge next April with
-- "I never authorised this" would have won, because there was nothing to show
-- them agreeing to anything. On Standard Connect that chargeback lands on the
-- CLUB's Stripe account, not the platform's — so it is the club's money and
-- the club's argument.
--
-- The literal text is stored, not just a version number. A year later, proving
-- what version 2 said is its own problem; the row saying exactly what was on
-- screen is not.
-- =============================================================================

create table if not exists public.payment_authorizations (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  household_id  uuid references public.households(id) on delete set null,
  member_id     uuid references public.household_members(id) on delete set null,

  kind          text not null,
  terms_version int  not null,
  -- Exactly what was on screen, agreement sentence included.
  terms_text    text not null,

  agreed_at     timestamptz not null default now(),
  -- Weak evidence individually, strong together, and free to collect.
  ip            text,
  user_agent    text,
  -- Which screen it came from: 'apply', 'renew', 'member_portal'.
  source        text,

  -- Kept rather than deleted on cancellation: the question a dispute asks is
  -- what was true on the day of the charge, not what is true now.
  revoked_at    timestamptz,
  revoked_by    uuid,

  created_at    timestamptz not null default now()
);

alter table public.payment_authorizations
  drop constraint if exists payment_authorizations_kind_known;
alter table public.payment_authorizations
  add constraint payment_authorizations_kind_known
  check (kind in ('auto_renew', 'payment_plan'));

alter table public.payment_authorizations
  drop constraint if exists payment_authorizations_terms_not_blank;
alter table public.payment_authorizations
  add constraint payment_authorizations_terms_not_blank
  check (length(btrim(terms_text)) > 20);

create index if not exists payment_authorizations_household_idx
  on public.payment_authorizations (household_id, kind, agreed_at desc);
create index if not exists payment_authorizations_tenant_idx
  on public.payment_authorizations (tenant_id, agreed_at desc);

alter table public.payment_authorizations enable row level security;
drop policy if exists payment_authorizations_service_role on public.payment_authorizations;
create policy payment_authorizations_service_role on public.payment_authorizations
  for all to service_role using (true) with check (true);

comment on table public.payment_authorizations is
  'Stored-credential consent. One row per time a member agreed to us charging a saved card, holding the exact wording they saw.';

-- =============================================================================
-- Text the whole club — with a second pair of eyes, and a way to buy more
-- =============================================================================
-- Poolside had no way to text every member. Adding one without a check would be
-- reckless: a blast is irreversible, lands on 150 phones in seconds, costs real
-- money, and the people sending it are volunteers doing club admin at 11pm on
-- their phone. One mis-tap should not be able to do that.
--
-- So a blast is composed by one admin and released by a different one. The row
-- below IS the pending state: nothing is sent until someone else approves it,
-- and an unapproved blast expires rather than lingering to be released days
-- later when it no longer makes sense.
--
-- Clubs with a single admin cannot get a second pair of eyes, so they confirm
-- deliberately instead (solo_confirmed) — recorded, so an audit can tell the
-- two situations apart.
-- =============================================================================

create table if not exists public.sms_blasts (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  body             text not null,
  audience         text not null default 'all',
  status           text not null default 'pending_approval'
                   check (status in ('pending_approval','sent','cancelled','expired','failed')),
  -- Who wrote it and who released it. Enforced different in the edge function;
  -- kept here so the audit trail survives even if that logic later changes.
  created_by       uuid references public.admin_users(id) on delete set null,
  approved_by      uuid references public.admin_users(id) on delete set null,
  solo_confirmed   boolean not null default false,
  recipient_count  int not null default 0,
  segment_count    int not null default 1,
  est_cost_cents   int not null default 0,
  sent_count       int,
  failed_count     int,
  cancel_reason    text,
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  sent_at          timestamptz,
  -- A blast nobody released within a day is almost certainly stale. Expiring
  -- it is safer than letting "pool closed today" go out on Thursday.
  expires_at       timestamptz not null default (now() + interval '24 hours')
);

create index if not exists sms_blasts_pending_idx
  on public.sms_blasts (tenant_id, status, created_at desc);

alter table public.sms_blasts enable row level security;
drop policy if exists sms_blasts_service on public.sms_blasts;
create policy sms_blasts_service on public.sms_blasts for all using (true) with check (true);

-- Bought texts, on top of the plan's monthly allowance. A club that runs out
-- mid-season should be able to keep going without upgrading a whole tier for
-- one busy month — and without Poolside eating the carrier cost.
alter table public.tenants
  add column if not exists sms_credits int not null default 0;

comment on column public.tenants.sms_credits is
  'Purchased SMS top-up balance, consumed only after the plan''s monthly allowance is used up.';

create table if not exists public.sms_credit_purchases (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants(id) on delete cascade,
  credits            int not null,
  amount_cents       int not null,
  stripe_session_id  text unique,
  purchased_by       uuid references public.admin_users(id) on delete set null,
  created_at         timestamptz not null default now()
);

create index if not exists sms_credit_purchases_tenant_idx
  on public.sms_credit_purchases (tenant_id, created_at desc);

alter table public.sms_credit_purchases enable row level security;
drop policy if exists sms_credit_purchases_service on public.sms_credit_purchases;
create policy sms_credit_purchases_service on public.sms_credit_purchases for all using (true) with check (true);

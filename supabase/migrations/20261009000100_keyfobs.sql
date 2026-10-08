-- Keyfob requests in the app (PLAN.md P, Doug 2026-10-08).
-- One row per fob, so a family can hold several. A new family gets the club's
-- included fobs (1 at Bishop); extras and replacements are paid ($15 at
-- Bishop) before the board issues them. The board types the fob's number to
-- issue it. Turning fobs on and off at the gate panel comes later (P5).

create table if not exists public.keyfobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  household_id    uuid not null references public.households(id) on delete cascade,
  member_id       uuid references public.household_members(id) on delete set null,
  card_number     bigint,
  status          text not null default 'requested'
                  check (status in ('requested', 'active', 'lost', 'off')),
  reason          text not null default 'extra'
                  check (reason in ('new_member', 'extra', 'replacement', 'imported', 'board')),
  included        boolean not null default false,
  price_cents     integer not null default 0 check (price_cents >= 0),
  payment_status  text not null default 'none'
                  check (payment_status in ('none', 'unpaid', 'pending_verify', 'paid')),
  payment_method  text,
  stripe_session_id text,
  paid_at         timestamptz,
  replaces_id     uuid references public.keyfobs(id) on delete set null,
  check_note      text,
  requested_at    timestamptz not null default now(),
  issued_at       timestamptz,
  issued_by       uuid,
  lost_at         timestamptz,
  turned_off_at   timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists keyfobs_household_idx on public.keyfobs (household_id);
create index if not exists keyfobs_tenant_status_idx on public.keyfobs (tenant_id, status);
-- A fob number belongs to one live fob in a club.
create unique index if not exists keyfobs_live_number_uniq on public.keyfobs (tenant_id, card_number)
  where card_number is not null and status <> 'off';
alter table public.keyfobs enable row level security;

-- Why a new family's free fob needs a second look (same address as a past
-- member), set at signup and shown to the board when issuing.
alter table public.applications add column if not exists fob_review_note text;

-- Whoever handles gate alerts can open the keyfob desk.
update public.board_positions set scopes = array_append(scopes, 'keyfobs')
  where slug = 'facilities' and not ('keyfobs' = any(scopes));

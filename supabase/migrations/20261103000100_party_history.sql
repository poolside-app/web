-- =============================================================================
-- party_history — every step of a party, as it happens (PLAN.md BP1)
-- =============================================================================
-- Doug, 2026-11-03: the Drive backup's Parties tab shows what actually
-- happened to each party, even one booked and then canceled. party_bookings
-- holds only where a party stands now, and six places change it (the board,
-- the family, Stripe, Venmo, the unpaid-hold release), so a trigger records
-- each change of status, payment, time or price here.
--
-- booking_id has no foreign key on purpose: deleting a family deletes its
-- parties, but not their history. Each row keeps the family name and the
-- party's details for the same reason. Only the service role reads it.
-- =============================================================================

create table if not exists public.party_history (
  id              bigserial primary key,
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  booking_id      uuid not null,
  at              timestamptz not null default now(),
  op              text not null,            -- insert | update | snapshot (where a party stood when this began)
  status          text,
  payment_status  text,
  payment_method  text,
  starts_at       timestamptz,
  ends_at         timestamptz,
  price_cents     integer,
  expected_guests integer,
  title           text,
  family_name     text,
  note            text,                     -- the board's note on the party at that moment
  decided_at      timestamptz,
  created_at      timestamptz
);
create index if not exists party_history_tenant_booking_idx on public.party_history (tenant_id, booking_id, at);
alter table public.party_history enable row level security;

create or replace function public.party_history_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and new.status is not distinct from old.status
     and new.payment_status is not distinct from old.payment_status
     and new.starts_at is not distinct from old.starts_at
     and new.ends_at is not distinct from old.ends_at
     and new.price_cents is not distinct from old.price_cents then
    return new;
  end if;
  insert into public.party_history (tenant_id, booking_id, op, status, payment_status, payment_method,
    starts_at, ends_at, price_cents, expected_guests, title, family_name, note, decided_at, created_at)
  values (new.tenant_id, new.id, lower(tg_op), new.status, new.payment_status, new.payment_method,
    new.starts_at, new.ends_at, new.price_cents, new.expected_guests, new.title,
    (select h.family_name from public.households h where h.id = new.household_id),
    new.admin_notes, new.decided_at, new.created_at);
  return new;
end;
$$;
revoke execute on function public.party_history_record() from anon, authenticated;

drop trigger if exists party_history_after on public.party_bookings;
create trigger party_history_after
  after insert or update on public.party_bookings
  for each row execute function public.party_history_record();

-- The parties already there start from where they stand now.
insert into public.party_history (tenant_id, booking_id, at, op, status, payment_status, payment_method,
  starts_at, ends_at, price_cents, expected_guests, title, family_name, note, decided_at, created_at)
select b.tenant_id, b.id, coalesce(b.paid_at, b.decided_at, b.updated_at, b.created_at), 'snapshot', b.status, b.payment_status, b.payment_method,
  b.starts_at, b.ends_at, b.price_cents, b.expected_guests, b.title,
  (select h.family_name from public.households h where h.id = b.household_id),
  b.admin_notes, b.decided_at, b.created_at
from public.party_bookings b
where not exists (select 1 from public.party_history ph where ph.booking_id = b.id);

-- PLAN.md BZ (Doug 11/6): a real PDF receipt for every card payment,
-- numbered per club per season ("2027-0001"). The PDF is drawn from this row
-- whenever it's needed (the email, the Drive copy), so the row keeps what the
-- receipt says, the club's name and address included. One per payment.
create table if not exists public.receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  season int not null,
  number int not null,
  payment_ref text not null,
  kind text not null,
  household_id uuid references public.households(id) on delete set null,
  application_id uuid,
  family_name text,
  family_address text,
  payer_name text,
  payer_email text,
  lines jsonb not null default '[]'::jsonb,
  card_fee_cents int not null default 0,
  total_cents int not null,
  paid_with text,
  balance_cents int,
  club_name text,
  club_address text,
  tz text,
  paid_at timestamptz not null default now(),
  drive_file_id text,
  created_at timestamptz not null default now(),
  unique (tenant_id, season, number),
  unique (tenant_id, payment_ref)
);
alter table public.receipts enable row level security;
create index if not exists receipts_application on public.receipts (application_id);
create index if not exists receipts_not_in_drive on public.receipts (tenant_id) where drive_file_id is null;

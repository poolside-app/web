-- Keyfobs at checkout (PLAN.md Q, Doug 2026-10-08). A family can add extra
-- fobs ($15 each at Bishop) when it signs up or renews. They're part of the
-- membership price, so card, Venmo and payment plans all include them, and
-- the board issues them at approval.
alter table public.applications add column if not exists fob_extra_count integer not null default 0
  check (fob_extra_count >= 0 and fob_extra_count <= 20);
alter table public.applications add column if not exists fob_cents integer not null default 0
  check (fob_cents >= 0);

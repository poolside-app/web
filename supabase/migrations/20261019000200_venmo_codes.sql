-- PLAN.md BC1 (Doug, 10/19): a short code on every Venmo payment. The
-- "Pay with Venmo" button puts it in the note ("Cabana Club 2027 dues -
-- Frevele - #K7Q2"), and the board looks for it in Venmo. Four characters
-- from letters and digits that can't be confused (no 0/O, 1/I/L).
create or replace function public.venmo_code() returns text
  language sql volatile set search_path = public as $$
  select string_agg(substr('23456789ABCDEFGHJKMNPQRSTUVWXYZ', 1 + floor(random() * 31)::int, 1), '')
  from generate_series(1, 4)
$$;
revoke execute on function public.venmo_code() from public, anon, authenticated;
grant execute on function public.venmo_code() to service_role;

alter table public.applications add column if not exists venmo_code text default public.venmo_code();
alter table public.party_bookings add column if not exists venmo_code text default public.venmo_code();
alter table public.keyfobs add column if not exists venmo_code text default public.venmo_code();

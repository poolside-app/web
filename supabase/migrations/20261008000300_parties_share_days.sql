-- Parties can share a day but never a time (PLAN.md O, Doug 2026-10-07).
-- The one-party-per-day rule becomes "no two booked parties overlap": the
-- database still refuses two paid parties at the same time, whatever the app
-- does, but two at different times on one day are fine.
create extension if not exists btree_gist;

drop index if exists public.party_bookings_one_per_pool_day_uniq;

-- Every party has an end now (members pick only the start). Older requests
-- without one get the club default of 4 hours.
update public.party_bookings set ends_at = starts_at + interval '4 hours' where ends_at is null;

alter table public.party_bookings drop constraint if exists party_bookings_booked_no_overlap;
alter table public.party_bookings add constraint party_bookings_booked_no_overlap
  exclude using gist (tenant_id with =, tstzrange(starts_at, ends_at) with &&)
  where (status = 'approved' and payment_status = 'paid' and ends_at is not null);

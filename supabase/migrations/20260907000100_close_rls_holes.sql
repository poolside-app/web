-- =============================================================================
-- 20260907000100 — close ten tables readable with the PUBLISHABLE key
-- =============================================================================
-- The publishable key ships in every page's HTML; anyone can read it out of
-- dev tools. Nothing in Poolside reaches Postgres except edge functions using
-- the service-role key, so no table should answer that key at all.
--
-- Two separate faults:
--
--   1. RLS switched off entirely: donations, sponsors, feedback_submissions.
--      Proven by inserting a throwaway sponsor row and reading it straight
--      back with the publishable key.
--
--   2. Seven more had RLS ENABLED — which is what made this hard to spot —
--      but their policy was granted to the `public` role instead of
--      `service_role`. `for all using (true)` to public denies nothing: an
--      open door with a lock fitted to it. external_calendar_feeds was
--      returning a live row containing a club's private Google Calendar iCal
--      URL, which is a bearer credential — anyone holding it can subscribe to
--      that calendar indefinitely.
--
-- The rest were empty only because Bishop has not used those features yet.
-- lifeguards / lifeguard_shifts / lifeguard_signups would have mattered most:
-- staff are frequently teenagers, and those tables say which named person is
-- scheduled at a pool at what time.
--
-- Verified before applying: no page anywhere calls /rest/v1 directly, so
-- nothing legitimate loses access. Verified after: tenant_public still
-- returns sponsors and today_checkins, and the calendar cron still syncs.
-- =============================================================================

alter table public.donations             enable row level security;
alter table public.sponsors              enable row level security;
alter table public.feedback_submissions  enable row level security;

drop policy if exists donations_service               on public.donations;
drop policy if exists sponsors_service                on public.sponsors;
drop policy if exists feedback_submissions_service    on public.feedback_submissions;
drop policy if exists external_calendar_feeds_service on public.external_calendar_feeds;
drop policy if exists lifeguards_service              on public.lifeguards;
drop policy if exists lifeguard_shifts_service        on public.lifeguard_shifts;
drop policy if exists lifeguard_signups_service       on public.lifeguard_signups;
drop policy if exists pool_checkins_service           on public.pool_checkins;
drop policy if exists sms_blasts_service              on public.sms_blasts;
drop policy if exists sms_credit_purchases_service    on public.sms_credit_purchases;

create policy donations_service               on public.donations               for all to service_role using (true) with check (true);
create policy sponsors_service                on public.sponsors                for all to service_role using (true) with check (true);
create policy feedback_submissions_service    on public.feedback_submissions    for all to service_role using (true) with check (true);
create policy external_calendar_feeds_service on public.external_calendar_feeds for all to service_role using (true) with check (true);
create policy lifeguards_service              on public.lifeguards              for all to service_role using (true) with check (true);
create policy lifeguard_shifts_service        on public.lifeguard_shifts        for all to service_role using (true) with check (true);
create policy lifeguard_signups_service       on public.lifeguard_signups       for all to service_role using (true) with check (true);
create policy pool_checkins_service           on public.pool_checkins           for all to service_role using (true) with check (true);
create policy sms_blasts_service              on public.sms_blasts              for all to service_role using (true) with check (true);
create policy sms_credit_purchases_service    on public.sms_credit_purchases    for all to service_role using (true) with check (true);

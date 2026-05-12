-- =============================================================================
-- external_calendar_feeds — read-only iCal/ICS feeds the admin imports
-- =============================================================================
-- Lets each tenant pull events from external calendar sources (Google
-- Calendar, Swimtopia, town events, etc.) into Poolside's unified calendar
-- view. One-way only — events stay editable in the source tool; Poolside
-- caches + renders them with a per-feed color so members can tell which
-- events come from where.
--
-- We cache fetched events in `cached_events` (JSONB) so the calendar
-- renders fast — a background refresh (every ~15 min) keeps the cache
-- current without hitting Google's iCal endpoint on every page load.
-- =============================================================================

create table if not exists public.external_calendar_feeds (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  label           text not null,                        -- "Bishop Estates Google Cal", "Swim Team"
  ical_url        text not null,                        -- raw .ics feed URL (Google secret URL ok)
  color           text not null default '#0a3b5c',      -- hex, used in calendar render
  enabled         boolean not null default true,
  cached_events   jsonb,                                -- last successful parse, [{summary, starts_at, ends_at, location, description, source_url}]
  last_synced_at  timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists external_calendar_feeds_tenant_idx
  on public.external_calendar_feeds (tenant_id, enabled);

alter table public.external_calendar_feeds enable row level security;
drop policy if exists external_calendar_feeds_service on public.external_calendar_feeds;
create policy external_calendar_feeds_service on public.external_calendar_feeds
  for all using (true) with check (true);

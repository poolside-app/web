-- =============================================================================
-- events: source columns for ICS-imported entries
-- =============================================================================
-- source_url + source_uid let us re-import / refresh / remove imported events
-- idempotently without touching native events. imported_at is for display +
-- audit (so admins know which ones came from a feed and when).
-- =============================================================================

alter table public.events add column if not exists source_url text;
alter table public.events add column if not exists source_uid text;
alter table public.events add column if not exists imported_at timestamptz;

-- Lookup by feed (used during refresh / remove subscription)
create index if not exists events_source_idx
  on public.events(tenant_id, source_url, source_uid)
  where source_url is not null;

-- Idempotency: a given (tenant, feed-url, ICS-UID) tuple can only land once
create unique index if not exists events_source_uid_unique
  on public.events(tenant_id, source_url, source_uid)
  where source_url is not null and source_uid is not null;

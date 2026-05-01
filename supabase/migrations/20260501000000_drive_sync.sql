-- =============================================================================
-- google_drive_grants — per-tenant OAuth + cached folder/sheet IDs
-- =============================================================================
-- Drive sync architecture: ONE-WAY, append-only. App → Drive replication
-- never propagates deletes or edits. The principle "Drive is the immutable
-- archive of record" is enforced by:
--   1. No delete actions exist in google_drive_sync function
--   2. drive_sync_log + drive_sync_queue have NO foreign key to applications
--      so audit pointers survive even when a tenant admin deletes an app row
--   3. Drive scope is drive.file (Google API rejects deletes outside scope)
-- =============================================================================

create table if not exists public.google_drive_grants (
  tenant_id          uuid primary key references public.tenants(id) on delete cascade,
  refresh_token      text not null,
  connected_email    text,
  connected_at       timestamptz not null default now(),
  last_sync_at       timestamptz,
  last_error         text,
  -- Cached IDs avoid round-trip lookups on every signup
  root_folder_id     text,
  club_folder_id     text,
  spreadsheet_id     text,
  year_folder_ids    jsonb not null default '{}'::jsonb,  -- { "2026": "abc...", "2027": "def..." }
  year_tab_ids       jsonb not null default '{}'::jsonb   -- { "2026": 12345, "2027": 67890 } (Sheets sheetId ints)
);

alter table public.google_drive_grants enable row level security;
drop policy if exists drive_grants_service on public.google_drive_grants;
create policy drive_grants_service on public.google_drive_grants for all using (true) with check (true);

-- =============================================================================
-- drive_sync_log — successful sync record (idempotency + audit pointer)
-- =============================================================================
-- application_id is intentionally a plain uuid, NOT a foreign key. This keeps
-- the audit trail in the DB even after the source application row is deleted
-- (the corresponding PDF + sheet row in Drive are also untouched, preserving
-- the legal-evidence chain).
-- =============================================================================

create table if not exists public.drive_sync_log (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  application_id  uuid not null,                 -- intentional non-FK
  drive_file_id   text,                          -- Drive ID of the PDF
  spreadsheet_id  text,                          -- Sheet file ID
  tab_name        text,                          -- e.g. "2026"
  row_index       int,                           -- approximate row position when written
  synced_at       timestamptz not null default now()
);
create unique index if not exists drive_sync_log_app_idx
  on public.drive_sync_log (tenant_id, application_id);
alter table public.drive_sync_log enable row level security;
drop policy if exists drive_sync_log_service on public.drive_sync_log;
create policy drive_sync_log_service on public.drive_sync_log for all using (true) with check (true);

-- =============================================================================
-- drive_sync_queue — pending + failed sync attempts to retry
-- =============================================================================

create table if not exists public.drive_sync_queue (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  application_id  uuid not null,                 -- intentional non-FK
  attempts        int not null default 0,
  last_error      text,
  next_retry_at   timestamptz not null default now(),
  status          text not null default 'pending' check (status in ('pending','done','failed')),
  created_at      timestamptz not null default now()
);
create unique index if not exists drive_sync_queue_app_idx
  on public.drive_sync_queue (tenant_id, application_id);
create index if not exists drive_sync_queue_pending_idx
  on public.drive_sync_queue (status, next_retry_at) where status = 'pending';
alter table public.drive_sync_queue enable row level security;
drop policy if exists drive_sync_queue_service on public.drive_sync_queue;
create policy drive_sync_queue_service on public.drive_sync_queue for all using (true) with check (true);

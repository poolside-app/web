-- Board minutes and bylaws backed up to the club's Google Drive (PLAN.md BV, Doug 11/5).
-- One draft file per meeting, rewritten when the draft changes (its id and a
-- hash of what it says); approved copies counted against posted_count; each
-- bylaws version's file; the "Board minutes" folder cached on the grant.
alter table public.board_meetings
  add column if not exists drive_draft_file_id text,
  add column if not exists drive_draft_hash text,
  add column if not exists drive_posted_count integer not null default 0;

alter table public.club_documents
  add column if not exists drive_file_id text;

alter table public.google_drive_grants
  add column if not exists minutes_folder_id text;

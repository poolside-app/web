-- =============================================================================
-- club-docs — the bylaws, for members only (PLAN.md BJ1)
-- =============================================================================
-- Doug, 2026-10-21: the bylaws, minutes and board names are for the club's
-- members only (K6 had them public). The bylaws PDFs move out of the public
-- club-assets folder into this private one; board_meetings hands signed-in
-- members and board members a link that works for an hour
-- (_shared/club_docs.ts). Only the service role reads it: no storage policies.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('club-docs', 'club-docs', false)
on conflict (id) do update set public = false;

-- Where the file is in club-docs. url keeps the old public address until the
-- file has moved, then goes empty.
alter table public.club_documents add column if not exists storage_path text;
alter table public.club_documents alter column url drop not null;
comment on table public.club_documents is
  'The bylaws, for the club''s members (PLAN.md K6, BJ1). Each upload is a new row; files live in the private club-docs bucket (storage_path).';

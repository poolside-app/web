-- Minutes uploaded for a meeting not taken in Poolside (PLAN.md BW, Doug 11/5).
-- A club_documents row of kind 'minutes': the meeting's date, who sees it
-- (members, the default, or private: board only) and the file's type. The
-- file lives in the private club-docs bucket, like the bylaws.
alter table public.club_documents drop constraint if exists club_documents_kind_check;
alter table public.club_documents add constraint club_documents_kind_check check (kind in ('bylaws', 'minutes'));

alter table public.club_documents
  add column if not exists meeting_date date,
  add column if not exists visibility text,
  add column if not exists content_type text;

alter table public.club_documents drop constraint if exists club_documents_visibility_check;
alter table public.club_documents add constraint club_documents_visibility_check
  check (visibility is null or visibility in ('members', 'private'));
alter table public.club_documents drop constraint if exists club_documents_minutes_date_check;
alter table public.club_documents add constraint club_documents_minutes_date_check
  check (kind <> 'minutes' or (meeting_date is not null and visibility is not null));

create index if not exists club_documents_minutes_idx on public.club_documents(tenant_id, kind, meeting_date desc);

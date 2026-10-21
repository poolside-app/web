-- =============================================================================
-- Minutes approval (PLAN.md BJ3)
-- =============================================================================
-- Doug, 2026-10-21: after the meeting closes, the note-taker submits the
-- minutes; every board member who attended approves (or asks for changes);
-- the moment the last one approves, members see them. The rules live in
-- supabase/functions/_shared/minutes_approval.ts.
--
-- minutes_status  draft → submitted → approved. A change to approved minutes
--                 makes them a draft again (an amendment); members keep seeing
--                 posted_json, the copy taken at the last approval.
-- approval_round  goes up each time they're submitted; asking for changes or
--                 resubmitting starts a new round.
-- =============================================================================

alter table public.board_meetings
  add column if not exists minutes_status text not null default 'draft'
    check (minutes_status in ('draft', 'submitted', 'approved')),
  add column if not exists approval_round integer not null default 0,
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_by uuid references public.admin_users(id) on delete set null,
  add column if not exists changes_note text,
  add column if not exists changes_by_name text,
  add column if not exists changes_at timestamptz,
  add column if not exists posted_json jsonb,
  add column if not exists posted_at timestamptz,
  add column if not exists posted_count integer not null default 0,
  add column if not exists approved_at timestamptz;

-- One row per approver per round. on_behalf: the President approved for them.
create table if not exists public.board_minutes_approvals (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  meeting_id       uuid not null references public.board_meetings(id) on delete cascade,
  round            integer not null,
  admin_id         uuid not null references public.admin_users(id) on delete cascade,
  name             text not null,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'voided')),
  decided_at       timestamptz,
  decided_by       uuid references public.admin_users(id) on delete set null,
  decided_by_name  text,
  on_behalf        boolean not null default false,
  created_at       timestamptz not null default now(),
  unique (meeting_id, round, admin_id)
);
create index if not exists board_minutes_approvals_pending_idx
  on public.board_minutes_approvals (tenant_id, status) where status = 'pending';
alter table public.board_minutes_approvals enable row level security;

-- Meetings closed before this keep their minutes, as approved, so nothing
-- disappears from the members' page.
update public.board_meetings
   set minutes_status = 'approved', approved_at = coalesce(ended_at, updated_at),
       posted_at = coalesce(edited_at, ended_at, updated_at), posted_count = 1,
       posted_json = jsonb_build_object(
         'title', title, 'meeting_date', meeting_date, 'location', location,
         'started_at', started_at, 'ended_at', ended_at, 'notes_md', coalesce(notes_md, ''),
         'attendees_json', attendees_json, 'votes_json', votes_json, 'follow_ups_json', follow_ups_json,
         'visibility', visibility)
 where status = 'completed' and minutes_status = 'draft' and posted_json is null;

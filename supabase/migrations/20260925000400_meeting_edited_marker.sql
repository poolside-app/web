-- =============================================================================
-- meeting_edited_marker — who last fixed closed minutes, and when
-- =============================================================================
-- Closed minutes can be corrected by the note-taker or the president
-- without re-opening the meeting, so its real start and end times and its
-- place on the public page are kept. The public page shows "Edited Sep 30
-- by Kristin"; the previous version goes to audit_log.
-- =============================================================================

alter table public.board_meetings
  add column if not exists edited_at timestamptz,
  add column if not exists edited_by uuid references public.admin_users(id) on delete set null;

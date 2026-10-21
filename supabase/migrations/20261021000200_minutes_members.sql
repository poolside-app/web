-- =============================================================================
-- Minutes: Members or Board only (PLAN.md BJ2)
-- =============================================================================
-- Doug, 2026-10-21: no public option. Minutes are for the club's members (the
-- default, shown on the members-only Bylaws & board minutes page, BJ1) or for
-- the board only (closed sessions). Minutes that were public become Members.
-- =============================================================================

alter table public.board_meetings drop constraint if exists board_meetings_visibility_check;
update public.board_meetings set visibility = 'members' where visibility = 'public';
alter table public.board_meetings add constraint board_meetings_visibility_check
  check (visibility in ('private', 'members'));
alter table public.board_meetings alter column visibility set default 'members';

drop index if exists public.idx_board_meetings_public;
create index if not exists idx_board_meetings_members
  on public.board_meetings (tenant_id, visibility, status)
  where visibility = 'members' and status = 'completed';

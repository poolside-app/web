-- =============================================================================
-- meetings_public_by_default — closing a meeting posts its minutes
-- =============================================================================
-- Doug, 2026-09-25: when the note-taker closes a meeting, the minutes go on
-- the club's public page right away. New meetings were board-only unless
-- someone remembered to switch them, so closing published nothing. They now
-- start public, and board-only is kept for closed sessions (member
-- discipline, legal). Existing meetings keep the setting they have.
-- =============================================================================

alter table public.board_meetings
  alter column visibility set default 'public';

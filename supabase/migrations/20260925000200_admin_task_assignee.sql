-- =============================================================================
-- admin_task_assignee — a dashboard task can be for one board member
-- =============================================================================
-- Tasks were routed only by permission (target_scopes), so every board
-- member with "events" saw every events task. Help requests and meeting
-- follow-ups belong to one person: the keyfob question goes to the keyfob
-- person. When assigned_admin_id is set, only that board member and the
-- president see the task, and only that board member gets the pop-up.
-- If they're removed from the board, the task falls back to the president.
-- =============================================================================

alter table public.admin_tasks
  add column if not exists assigned_admin_id uuid
    references public.admin_users(id) on delete set null;

create index if not exists admin_tasks_assignee_open_idx
  on public.admin_tasks(assigned_admin_id)
  where completed_at is null and dismissed_at is null and assigned_admin_id is not null;

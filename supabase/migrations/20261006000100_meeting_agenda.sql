-- =============================================================================
-- meeting_agenda — board meeting agendas built from one-liners (PLAN.md L)
-- =============================================================================
-- Doug, 2026-10-06: anyone on the board adds a one-line item (100 characters at
-- most) for the next meeting at any time. Right before the meeting someone
-- presses "Create agenda", which lays the items out with each person's items
-- under their name. It's sent to the board only when someone presses "Send to
-- the board". Anything not checked off at the meeting carries over.
--
--   agenda_items.meeting_id    null = waiting for the next meeting
--   agenda_items.covered       checked off at the meeting
--   agenda_items.carried_from  the meeting it wasn't reached at
--   board_meetings.planned_time        "10:00", in pool time
--   board_meetings.agenda_created_*    when "Create agenda" was pressed, by whom
--   board_meetings.agenda_sent_*       when it was last sent to the board, by whom
-- =============================================================================

create table if not exists public.agenda_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  body           text not null check (length(body) between 1 and 100 and body !~ '[\r\n]'),
  added_by       uuid references public.admin_users(id) on delete set null,
  added_by_name  text,
  meeting_id     uuid references public.board_meetings(id) on delete set null,
  covered        boolean not null default false,
  carried_from   uuid references public.board_meetings(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists agenda_items_tenant_idx on public.agenda_items(tenant_id, meeting_id, created_at);
alter table public.agenda_items enable row level security;

alter table public.board_meetings
  add column if not exists planned_time       text check (planned_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  add column if not exists agenda_created_at  timestamptz,
  add column if not exists agenda_created_by  uuid references public.admin_users(id) on delete set null,
  add column if not exists agenda_sent_at     timestamptz,
  add column if not exists agenda_sent_by     uuid references public.admin_users(id) on delete set null;

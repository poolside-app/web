-- =============================================================================
-- 20260508000100 — board_meetings
-- =============================================================================
-- Secretary's note-taking surface. Stores one row per meeting with structured
-- attendance, notes, votes, and follow-ups. Designed for the "Grandma Betty"
-- live-note-taking flow: secretary clicks "Start meeting", types as the
-- meeting progresses, autosaves every few seconds, clicks "Finalize" at the
-- end to lock the record.
--
-- attendees_json shape:
--   [{ admin_user_id?: uuid, name: text, role: text, source: 'admin' | 'manual' }]
--
-- votes_json shape:
--   [{ id: text, motion: text, proposed_by?: text, seconded_by?: text,
--      yes: int, no: int, abstain: int, outcome: 'passed' | 'failed' | 'tabled' | 'pending',
--      notes?: text }]
--
-- follow_ups_json shape:
--   [{ id: text, description: text, assigned_to?: text, due_date?: date,
--      status: 'open' | 'done' | 'cancelled' }]
--
-- We keep these as JSONB rather than separate tables because the secretary's
-- mental model is "the meeting is one thing" — they don't think about joins.
-- Trade-off: harder to do cross-meeting queries ("every motion that ever
-- passed about gate access"). Acceptable for v1; can promote to tables later.
-- =============================================================================

create table if not exists public.board_meetings (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,

  title           text not null default 'Board Meeting',
  meeting_date    date not null default current_date,
  location        text,

  -- Lifecycle: draft (just created, never started) → in_progress (Start
  -- clicked, secretary is typing) → completed (Finalize clicked, locked).
  status          text not null default 'draft'
                    check (status in ('draft', 'in_progress', 'completed')),
  started_at      timestamptz,
  ended_at        timestamptz,

  -- Visibility on the public /governance.html page:
  --   private  — board only (default for safety; secretary opts in to make public)
  --   public   — visible to anyone visiting the club's public site
  visibility      text not null default 'private'
                    check (visibility in ('private', 'public')),

  -- Live-typing fields (autosaved every few seconds during the meeting).
  notes_md        text not null default '',
  attendees_json  jsonb not null default '[]'::jsonb,
  votes_json      jsonb not null default '[]'::jsonb,
  follow_ups_json jsonb not null default '[]'::jsonb,

  created_by      uuid references public.admin_users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists idx_board_meetings_tenant_date
  on public.board_meetings (tenant_id, meeting_date desc);

create index if not exists idx_board_meetings_public
  on public.board_meetings (tenant_id, visibility, status)
  where visibility = 'public' and status = 'completed';

-- RLS: edge functions use service role; lock down direct API access so
-- private meeting notes can't leak via a stolen anon key.
alter table public.board_meetings enable row level security;
-- (No policies = nobody at the API layer can read/write. Service role bypasses RLS.)

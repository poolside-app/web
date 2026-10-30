-- =============================================================================
-- Sign-ups: shifts and jobs, with a thank-you (PLAN.md BM, Doug 10/23)
-- =============================================================================
-- Builds on volunteer_opportunities / volunteer_signups (April). A post is a
-- *shift* (a start and spots) or a *job* (a do-by date or none, photos). Each
-- can carry a thank-you: nothing, a line, or money off next season (a
-- one-family discount code made when the poster approves the work).
--
-- A sign-up: confirmed → done (the volunteer tapped Done, with a photo) →
-- approved (the poster or the President OK'd it). A shift's poster ticks who
-- came: approved or no_show. A thank-you goes on the news as a post of kind
-- 'thanks', kept apart from the 15 announcements (PLAN.md AQ).
-- =============================================================================

alter table public.volunteer_opportunities
  add column if not exists kind text not null default 'shift' check (kind in ('shift', 'job')),
  add column if not exists due_on date,
  add column if not exists photos jsonb not null default '[]'::jsonb,
  add column if not exists reward_kind text not null default 'none' check (reward_kind in ('none', 'note', 'discount')),
  add column if not exists reward_note text,
  add column if not exists reward_amount_cents int check (reward_amount_cents > 0),
  add column if not exists reward_percent numeric check (reward_percent > 0 and reward_percent <= 100),
  add column if not exists created_by uuid references public.admin_users(id) on delete set null,
  add column if not exists created_by_name text,
  add column if not exists closed_at timestamptz,
  add column if not exists attendance_asked_at timestamptz;

-- A job needn't have a start.
alter table public.volunteer_opportunities alter column starts_at drop not null;
alter table public.volunteer_opportunities drop constraint if exists volunteer_opps_shift_has_start;
alter table public.volunteer_opportunities add constraint volunteer_opps_shift_has_start check (kind = 'job' or starts_at is not null);

alter table public.volunteer_signups drop constraint if exists volunteer_signups_status_check;
alter table public.volunteer_signups add constraint volunteer_signups_status_check
  check (status in ('confirmed', 'cancelled', 'done', 'approved', 'no_show'));

alter table public.volunteer_signups
  add column if not exists done_at timestamptz,
  add column if not exists done_photo_url text,
  add column if not exists done_note text,
  add column if not exists approved_at timestamptz,
  add column if not exists approved_by uuid references public.admin_users(id) on delete set null,
  add column if not exists approved_by_name text,
  add column if not exists sent_back_note text,
  add column if not exists sent_back_at timestamptz,
  add column if not exists discount_code_id uuid references public.discount_codes(id) on delete set null,
  add column if not exists thanks_post_id uuid references public.posts(id) on delete set null;

-- A family can sign up again after cancelling: only live sign-ups are unique.
alter table public.volunteer_signups drop constraint if exists volunteer_signups_opportunity_id_member_id_key;
create unique index if not exists volunteer_signups_one_live_per_member
  on public.volunteer_signups (opportunity_id, member_id) where status <> 'cancelled';

-- News posts: a photo, and whether it's a thank-you.
alter table public.posts
  add column if not exists image_url text,
  add column if not exists kind text not null default 'post' check (kind in ('post', 'thanks'));

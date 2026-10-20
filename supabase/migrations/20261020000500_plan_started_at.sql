-- PLAN.md BG4 (10/20 audit): when a family's payment plan started. Their
-- application stays "pending" until the plan is paid off, so it has no
-- paid_at; the "You're in!" page's Sign in button reads this instead.
alter table public.applications add column if not exists plan_started_at timestamptz;

-- Auto-renew becomes "approve next season" (PLAN.md R7, Doug 2026-10-08).
-- When renewals open, an auto-renew family is sent the new price, policies
-- and payment choice to approve, and nothing is charged until they do; one
-- reminder a week later. These record when each was sent for which season.
alter table public.households add column if not exists auto_renew_asked_year integer;
alter table public.households add column if not exists auto_renew_asked_at timestamptz;
alter table public.households add column if not exists auto_renew_reminded_at timestamptz;

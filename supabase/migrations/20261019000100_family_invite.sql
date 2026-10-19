-- PLAN.md AZ (Doug, 10/19): text a family member a link to get the app.
-- When they were last sent one, so a person gets at most one a day and a
-- family a few (_shared/family_invite.ts).
alter table public.household_members add column if not exists app_invited_at timestamptz;

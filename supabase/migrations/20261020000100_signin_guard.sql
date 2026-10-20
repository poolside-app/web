-- PLAN.md BG1 (10/20 audit): board and provider passwords, and board sign-in
-- codes, lock for 15 minutes after 5 wrong tries (_shared/signin_guard.ts).
-- Member codes already count wrong tries on member_magic_links.code_attempts.
alter table public.admin_users add column if not exists failed_logins int not null default 0;
alter table public.admin_users add column if not exists locked_until timestamptz;
alter table public.provider_admins add column if not exists failed_logins int not null default 0;
alter table public.provider_admins add column if not exists locked_until timestamptz;
alter table public.admin_magic_links add column if not exists code_attempts int not null default 0;

-- =============================================================================
-- drop_google_sign_in — Sign in with Google is gone
-- =============================================================================
-- Doug, 2026-09-25: "remove all the sign in with google stuff". Members and
-- the board sign in with a text code (or an email link); the board also has
-- email + password. The google_oauth function, its buttons and its Vercel
-- rewrite are removed, so nothing reads or writes these columns any more.
-- The privacy page no longer lists a Google account ID, so the one stored
-- value goes too. (Google Drive backup is separate and unaffected.)
-- =============================================================================

alter table public.admin_users       drop column if exists google_sub;
alter table public.household_members drop column if exists google_sub;

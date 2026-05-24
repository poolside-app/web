-- =============================================================================
-- applications.no_app_member: "guest checkout" — pay dues, skip the app
-- =============================================================================
-- Doug 2026-05-23: many real members (often older board veterans) want to
-- pay their annual dues + use the pool but don't want to set up a Poolside
-- login. The apply form will offer a "Just sign me up" radio at the top
-- of step 1; checking it sets this flag.
--
-- Downstream effects keyed off this flag:
--   - Welcome email picks the _no_app template variants (no magic-link CTA,
--     short + warm copy with a single "you can opt in later" line at the bottom)
--   - Admin Pipeline shows a small 🚫 no app pill so the board knows not to
--     expect this person in the member portal
--   - Apply form success page omits "we texted you a sign-in link" copy
--
-- The flag is purely informational — the member's household_members row is
-- created identically and they can magic-link in at any time later if they
-- change their mind. We're documenting intent, not gating capability.
-- =============================================================================

alter table public.applications
  add column if not exists no_app_member boolean not null default false;

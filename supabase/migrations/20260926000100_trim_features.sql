-- =============================================================================
-- trim_features — anonymous feedback, campaign pop-ups, Impact and guest passes
-- =============================================================================
-- Doug, 2026-09-26: "too many features… too convoluted". The duplicates and
-- fluff go:
--   feedback_submissions — anonymous feedback; Ask the board (help_requests)
--                          replaces it
--   campaigns            — pop-ups; news posts and discount codes replace them
--   guest_pass_packs/uses — guest passes, retired 2026-09-07 but left behind
--   the Impact page       — kept no table; its permission and hourly-rate
--                          setting go
-- Every table was empty when this ran. The functions, pages and nav entries
-- were removed in the same change.
-- =============================================================================

drop table if exists public.guest_pass_uses;
drop table if exists public.guest_pass_packs;
drop table if exists public.campaigns;
drop table if exists public.feedback_submissions;

-- Permissions that no longer exist.
update public.admin_users
   set scopes = array(select s from unnest(scopes) s where s not in ('impact', 'campaigns', 'passes'))
 where scopes && array['impact', 'campaigns', 'passes'];

-- Settings that no longer do anything.
update public.settings
   set value = (value - 'value_per_hour')
             #- '{features,campaigns}'
             #- '{features,guest_passes}';

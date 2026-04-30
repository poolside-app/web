-- =============================================================================
-- applications.tier_slug — capture which membership tier the applicant chose
-- =============================================================================
-- Bishop Estates (and most pool clubs) offer multiple membership tiers
-- (Family / Single / Senior / etc.) at different prices. The applicant
-- picks one on the apply form; admin can override on approval but the
-- captured choice carries through to household.tier by default.
--
-- Tier definitions live in `settings.value.membership_tiers` so each
-- tenant can define their own set without a separate table.
-- =============================================================================

alter table public.applications
  add column if not exists tier_slug text;

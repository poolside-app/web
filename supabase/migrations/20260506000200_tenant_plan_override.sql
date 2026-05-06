-- =============================================================================
-- Plan override columns on tenants
-- =============================================================================
-- Provider admins occasionally need to make a tenant exempt from the default
-- plan caps without inventing a new plan slug. Two new optional columns:
--   plan_label_override     — display name used in admin/member UIs in place
--                             of the default ("Free Forever", "Pro", etc.).
--                             e.g. "Grandfathered" for Bishop Estates.
--   household_cap_override  — bypass the default per-plan household cap.
--                             null   → use plan default
--                             >= 0   → exact cap (use a huge number for "∞")
-- Existing `plan` column is left untouched so billing logic that references
-- it (Stripe plan key, feature gates) still works unchanged.
-- =============================================================================

alter table public.tenants
  add column if not exists plan_label_override    text,
  add column if not exists household_cap_override int
    check (household_cap_override is null or household_cap_override >= 0);

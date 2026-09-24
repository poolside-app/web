-- =============================================================================
-- pin_trigger_search_path — clear the last "mutable search_path" advisor warnings
-- =============================================================================
-- These trigger functions only use now() and the fully qualified
-- public.household_members, so pinning the path changes nothing they do.
-- =============================================================================

alter function public.fn_household_member_cap()      set search_path = public;
alter function public.fn_set_updated_at()            set search_path = public;
alter function public.fn_sponsors_touch_updated_at() set search_path = public;

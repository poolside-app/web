-- =============================================================================
-- application_emergency_contact — keep the emergency contact the form requires
-- =============================================================================
-- apply.html requires an emergency contact and sends it as emergency_contact,
-- but applications had no column for it, so submit dropped it and every
-- approved family's "Emergency contact" was blank. It's now stored on the
-- application and copied to households.emergency_contact at approval.
-- =============================================================================

alter table public.applications
  add column if not exists emergency_contact text;

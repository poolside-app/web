-- =============================================================================
-- 20260508000200 — board_title on admin_users
-- =============================================================================
-- Display-only "what's this person CALLED on the board" field. Distinct
-- from role_template (which controls PERMISSIONS). One person could be
-- "President" with owner-equivalent scopes; another could be "Vice
-- President" with the same permissions but a different title; a third
-- could be "Treasurer" with treasurer-template permissions.
--
-- Free text — we don't constrain to a fixed enum because clubs use
-- variations (Treasurer, Co-Treasurer, Acting Treasurer, etc.) The UI
-- offers a dropdown of common titles + a custom option.
-- =============================================================================

alter table public.admin_users
  add column if not exists board_title text;

-- Backfill existing admins with the role-template label as a sensible
-- default so nothing renders blank in attendance lists. Owners → President
-- since that's the most common pool-club mapping; the rest map to their
-- role label.
update public.admin_users set board_title = 'President'        where role_template = 'owner'         and board_title is null;
update public.admin_users set board_title = 'Treasurer'        where role_template = 'treasurer'     and board_title is null;
update public.admin_users set board_title = 'Membership Chair' where role_template = 'membership'    and board_title is null;
update public.admin_users set board_title = 'Volunteer Coord.' where role_template = 'events'        and board_title is null;
update public.admin_users set board_title = 'Communications'   where role_template = 'communications' and board_title is null;
update public.admin_users set board_title = 'Secretary'        where role_template = 'secretary'     and board_title is null;

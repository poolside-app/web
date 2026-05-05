-- =============================================================================
-- admin_roles_v2 — multi-role admins + linked_member_id + dismiss flag
-- =============================================================================
-- Schema evolution to support the role-based admin model from the
-- 2026-05 UX review. Three independent additions, all backward compatible
-- with the existing role_template + scopes columns:
--
--   1. roles text[] — a Margaret can be both 'communications' and
--      'volunteer'; the existing role_template column is single-value and
--      we kept it so old code paths keep working. New code reads roles[]
--      first; if empty, falls back to [role_template].
--
--   2. linked_member_id — admins can ALSO be members of the club (their
--      family uses the pool). This FK to household_members lets us avoid
--      the brittle email-string match. Set automatically by
--      applications.approve when an approved household member's email
--      matches an existing admin_users row. Nullable by design — paid
--      bookkeepers and other non-member admins exist.
--
--   3. member_apply_dismissed — for admins who explicitly say "I'm not
--      a member, stop nagging me to apply." Set by the founder banner
--      on the admin home.
-- =============================================================================

alter table public.admin_users
  add column if not exists roles                  text[]    not null default '{}'::text[],
  add column if not exists linked_member_id       uuid      references public.household_members(id) on delete set null,
  add column if not exists member_apply_dismissed boolean   not null default false;

-- Backfill roles[] from role_template for every existing admin so the
-- legacy column stays in sync. Skip rows that already have a non-empty
-- roles[] (idempotent re-run safe).
update public.admin_users
   set roles = array[role_template]
 where (roles is null or array_length(roles, 1) is null)
   and role_template is not null
   and role_template <> '';

create index if not exists admin_users_roles_idx
  on public.admin_users using gin (roles);

create index if not exists admin_users_linked_member_idx
  on public.admin_users (linked_member_id)
  where linked_member_id is not null;

-- For applications.approve to look up which admin_users to auto-link.
create index if not exists admin_users_email_lower_idx
  on public.admin_users (lower(email))
  where active = true;

-- =============================================================================
-- household_members.directory_visible — opt-in member directory
-- =============================================================================
-- Replaces the paper directory clubs print every year. Default OFF (opt-in
-- privacy posture). Admins can flip it bulk per household for board folks
-- who want their volunteer role visible.
-- =============================================================================

alter table public.household_members
  add column if not exists directory_visible boolean not null default false;

create index if not exists household_members_directory_idx
  on public.household_members(tenant_id, directory_visible)
  where active = true and directory_visible = true;

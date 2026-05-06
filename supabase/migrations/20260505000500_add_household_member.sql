-- =============================================================================
-- add_household_member — schema support for member-added family members
-- =============================================================================
-- After a household joins, the primary member can add additional household
-- members from /m/ without going through the full apply flow. These rows
-- still need legal-evidence: the policies the new member accepted + a
-- signature (their own if adult, the guardian's if minor).
--
-- We store this directly on household_members so the row IS the record.
-- Audit log carries the timestamp + actor (the primary who added them).
-- =============================================================================

alter table public.household_members
  add column if not exists policies_accepted        jsonb       not null default '{}'::jsonb,
  add column if not exists policies_accepted_at     timestamptz,
  add column if not exists signature_url            text,
  add column if not exists guardian_signature_url   text,
  add column if not exists added_by_member_id       uuid references public.household_members(id) on delete set null,
  add column if not exists added_via                text;  -- 'apply' | 'admin_create' | 'member_add'

create index if not exists household_members_added_by_idx
  on public.household_members(added_by_member_id)
  where added_by_member_id is not null;

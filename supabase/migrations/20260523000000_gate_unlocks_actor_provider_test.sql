-- =============================================================================
-- gate_unlocks.actor_kind: add 'provider_test' to the check constraint
-- =============================================================================
-- The original 2026-05-05 migration whitelisted ('member', 'admin_test',
-- 'system'). After the provider-side super_test_unlock endpoint shipped in
-- gate_admin (Doug 2026-05-08), inserts with actor_kind='provider_test'
-- started failing with "new row for relation 'gate_unlocks' violates check
-- constraint 'gate_unlocks_actor_kind_check'".
--
-- Distinct from 'admin_test' (which is a TENANT admin clicking Test unlock
-- from their own Settings page) so the audit trail can tell platform-owner
-- Doug-initiated tests apart from club-staff tests. Both are legitimate
-- unlock kinds and should never have been mutually exclusive.
-- =============================================================================

alter table public.gate_unlocks
  drop constraint if exists gate_unlocks_actor_kind_check;

alter table public.gate_unlocks
  add constraint gate_unlocks_actor_kind_check
  check (actor_kind in ('member', 'admin_test', 'provider_test', 'system'));

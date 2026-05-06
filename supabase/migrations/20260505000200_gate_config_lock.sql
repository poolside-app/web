-- =============================================================================
-- gate_config_lock — admin-side lock for panel host/credentials
-- =============================================================================
-- Once an admin verifies the gate works, they click "Lock" and the panel
-- config (host + admin user + password + bridge secret rotation) becomes
-- read-only until explicitly unlocked. Protects against:
--   - A co-Board-chair fat-fingering the panel IP and breaking unlocks
--   - An accidentally-elevated admin tweaking secrets out of curiosity
--
-- The lock is per-tenant (lives on gate_panels). Owner-role admins can
-- toggle it; the toggle itself is audit-logged.
-- =============================================================================

alter table public.gate_panels
  add column if not exists config_locked     boolean not null default false,
  add column if not exists config_locked_at  timestamptz,
  add column if not exists config_locked_by  uuid;

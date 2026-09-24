-- =============================================================================
-- new_functions_private — functions our migrations create start out private
-- =============================================================================
-- 20260924000200_lock_down_rpc removed anon/authenticated from the per-schema
-- default for public, but Postgres also grants EXECUTE to PUBLIC through its
-- *global* default, and a per-schema revoke can't take that back — so a new
-- function was still callable by anyone (anon inherits PUBLIC). This clears
-- the global default for functions the postgres role creates. service_role
-- keeps its explicit per-schema grant; pg_cron runs as postgres, the owner.
-- Checked by scripts/test_rpc_lockdown.mjs ("a function added later starts
-- out private").
-- =============================================================================

alter default privileges for role postgres revoke execute on functions from public;

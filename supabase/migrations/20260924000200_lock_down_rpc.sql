-- =============================================================================
-- lock_down_rpc — only the server and the scheduler may run database functions
-- =============================================================================
-- Postgres lets everyone (PUBLIC) execute a new function unless told
-- otherwise, and Supabase's defaults add the anon and authenticated roles.
-- The anon key ships in every page, so anyone could call these directly at
-- /rest/v1/rpc/<name>, skipping every check in the Edge Functions:
--
--   consume_sms_credit(s)   spend a club's prepaid text credits (needs only
--                           the club's id, which any member's token carries)
--   run_*_cron              start the auto-renew, payment-plan, cleanup,
--                           calendar and gate jobs on demand — in a loop, that
--                           burns the invocation quota and takes the site down
--
-- Nothing legitimate calls them that way. The Edge Functions use the
-- service_role key (_shared/sms_cap.ts is the only rpc() caller) and pg_cron
-- runs jobs as postgres, the owner. Verified by scripts/test_rpc_lockdown.mjs.
-- =============================================================================

revoke execute on function public.consume_sms_credit(uuid)            from public, anon, authenticated;
revoke execute on function public.consume_sms_credits(uuid, integer)  from public, anon, authenticated;
revoke execute on function public.run_applications_cleanup_cron()     from public, anon, authenticated;
revoke execute on function public.run_auto_renew_cron()               from public, anon, authenticated;
revoke execute on function public.run_external_calendar_cron()        from public, anon, authenticated;
revoke execute on function public.run_gate_bridge_monitor_cron()      from public, anon, authenticated;
revoke execute on function public.run_payment_plans_cron()            from public, anon, authenticated;

grant execute on function public.consume_sms_credit(uuid)           to service_role;
grant execute on function public.consume_sms_credits(uuid, integer) to service_role;

-- Trigger functions: nothing can call these usefully from outside, but they
-- were open too. Triggers don't check EXECUTE when they fire, so this changes
-- nothing for inserts and updates.
revoke execute on function public.fn_household_member_cap()      from public, anon, authenticated;
revoke execute on function public.fn_set_updated_at()            from public, anon, authenticated;
revoke execute on function public.fn_sponsors_touch_updated_at() from public, anon, authenticated;

-- SECURITY DEFINER functions should not resolve names through a caller-
-- controlled search_path. These already qualify vault.* and net.*.
alter function public.run_applications_cleanup_cron() set search_path = public;
alter function public.run_external_calendar_cron()    set search_path = public;
alter function public.run_gate_bridge_monitor_cron()  set search_path = public;
alter function public.run_payment_plans_cron()        set search_path = public;

-- The root cause: every function a migration creates starts out callable by
-- the world. From now on they start private; grant service_role explicitly.
alter default privileges for role postgres in schema public
  revoke execute on functions from public, anon, authenticated;

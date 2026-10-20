-- PLAN.md BG8 (10/20 audit): the scheduled calls waited pg_net's default 5
-- seconds, so a slow-but-fine run (the applications cleanup takes up to ~13 s)
-- was logged as "timed out" and a real failure looked the same. Each wrapper
-- now waits 30 seconds. Everything else in the functions stays as it is: the
-- definition is read back and only timeout_milliseconds is added.
do $$
declare f text; def text;
begin
  foreach f in array array['run_payment_plans_cron', 'run_auto_renew_cron', 'run_gate_bridge_monitor_cron',
                           'run_external_calendar_cron', 'run_applications_cleanup_cron'] loop
    select pg_get_functiondef(('public.' || f)::regproc) into def;
    if def !~* 'timeout_milliseconds' then
      def := regexp_replace(def, 'net\.http_post\(', 'net.http_post(timeout_milliseconds := 30000, ', 'gi');
      execute def;
    end if;
  end loop;
end $$;

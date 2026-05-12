-- =============================================================================
-- external_calendar cron — every 15 min refresh of all enabled iCal feeds
-- =============================================================================
-- Hits the external_calendar edge function with action=cron_sync_all. The
-- function authenticates via x-cron-secret (same secret as payment_plans cron
-- — already in Supabase Vault as 'cron_secret'). Function iterates every
-- enabled external_calendar_feeds row across all tenants and re-fetches.
--
-- Also adds:
--   • consecutive_failures int — for the failed-fetch alerting flow. Resets
--     to 0 on success, increments on each failure. Email fires at 3.
--   • last_alert_sent_at — anti-spam: don't alert more than once per 24h
--     even if failures keep stacking.
-- =============================================================================

alter table public.external_calendar_feeds
  add column if not exists consecutive_failures int not null default 0,
  add column if not exists last_alert_sent_at timestamptz;

create extension if not exists pg_cron;
create extension if not exists pg_net;

create or replace function public.run_external_calendar_cron()
returns void
language plpgsql
security definer
as $$
declare
  v_secret text;
  v_url    text := 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/external_calendar';
begin
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  exception when others then
    raise notice 'cron_secret not in vault yet; skipping external_calendar cron';
    return;
  end;
  if v_secret is null then
    raise notice 'cron_secret not set; skipping external_calendar cron';
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'x-cron-secret', v_secret
    ),
    body    := jsonb_build_object('action', 'cron_sync_all')
  );
end;
$$;

-- Schedule: every 15 minutes. Calendar staleness > 15 min is a noticeable
-- volunteer-UX papercut ("I added the board meeting in Google an hour ago
-- and it's not showing up yet"). 15 is the sweet spot — fast enough to feel
-- live, slow enough that we're not hammering Google's iCal endpoint.
do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'external_calendar_15min'
  ) then
    perform cron.schedule(
      'external_calendar_15min',
      '*/15 * * * *',
      $cron$ select public.run_external_calendar_cron(); $cron$
    );
  end if;
end $$;

-- =============================================================================
-- drive_nightly — the Drive backup's nightly catch-up (PLAN.md BP3)
-- =============================================================================
-- Each night at 10:00 UTC (2 AM Pacific in winter, 3 AM in summer):
-- google_drive_sync cron_nightly retries waiting backups, copies any signup or
-- signed renewal that never got copied, and brings the Parties tab up to date,
-- for every club with Drive connected. Same Vault secret as the other jobs.
-- =============================================================================

create or replace function public.run_drive_nightly_cron()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
  v_url    text := 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/google_drive_sync';
begin
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  exception when others then
    raise notice 'cron_secret not in vault yet; skipping drive nightly cron';
    return;
  end;
  if v_secret is null then
    raise notice 'cron_secret not set; skipping drive nightly cron';
    return;
  end if;

  perform net.http_post(timeout_milliseconds := 120000,
    url     := v_url,
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'x-cron-secret', v_secret
    ),
    body    := jsonb_build_object('action', 'cron_nightly')
  );
end;
$$;

-- Only pg_cron calls it; over /rest/v1/rpc/ a stranger could start the run.
revoke execute on function public.run_drive_nightly_cron() from anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'drive_nightly') then
    perform cron.schedule(
      'drive_nightly',
      '0 10 * * *',
      $cron$ select public.run_drive_nightly_cron(); $cron$
    );
  end if;
end $$;

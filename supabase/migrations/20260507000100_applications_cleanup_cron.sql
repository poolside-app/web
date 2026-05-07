-- =============================================================================
-- applications cleanup cron — auto-delete abandoned Stripe applications
-- =============================================================================
-- Runs every 30 minutes. Hard-deletes applications where the applicant
-- chose Stripe (single-pay or payment plan), never completed checkout,
-- and the row is older than the abandonment window (60 min, enforced
-- inside the edge function). Keeps the admin's "Pipeline" view from
-- filling up with pending-unpaid ghosts that will never resolve.
--
-- Auth model: same as payment_plans — the edge function checks the
-- x-cron-secret header against the CRON_SECRET env var. The pg_cron
-- job pulls that secret from Supabase Vault. No hardcoded secrets here.
--
-- The CRON_SECRET / Vault entries are already in place from the
-- payment_plans cron migration, so this just adds the schedule.
-- =============================================================================

-- Wrapper function. Mirrors the run_payment_plans_cron pattern: pull
-- secret from Vault at call time, no-op if not configured yet.
create or replace function public.run_applications_cleanup_cron()
returns void
language plpgsql
security definer
as $$
declare
  v_secret text;
  v_url    text := 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/applications';
begin
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  exception when others then
    raise notice 'cron_secret not in vault yet; skipping applications cleanup';
    return;
  end;
  if v_secret is null then
    raise notice 'cron_secret not set; skipping applications cleanup';
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type',   'application/json',
      'x-cron-secret',  v_secret
    ),
    body    := jsonb_build_object('action', 'cron_cleanup_abandoned')
  );
end;
$$;

-- Schedule: every 30 minutes. Stripe webhook usually fires within seconds
-- so 60-minute abandonment + 30-minute scan cadence means worst case the
-- ghost row sits in the pipeline for ~90 minutes before being swept.
do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'applications_cleanup'
  ) then
    perform cron.schedule(
      'applications_cleanup',
      '*/30 * * * *',
      $cron$ select public.run_applications_cleanup_cron(); $cron$
    );
  end if;
end $$;

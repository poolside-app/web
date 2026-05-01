-- =============================================================================
-- payment_plans cron — daily charges + reminders via pg_cron + pg_net
-- =============================================================================
-- Runs the payment_plans edge function once a day to:
--   • Charge installments with due_date <= today (off-session via saved card)
--   • Send reminder emails at 14/7/1 days before due
--   • Declare lapses on chronic charge failures
--
-- Auth model: edge function checks the x-cron-secret header against the
-- CRON_SECRET env var. The pg_cron job pulls that secret from Supabase
-- Vault. This means: NEVER hardcode the secret in this migration.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ONE-TIME SETUP (run as Doug, the platform owner) — not in this migration:
--   1. Generate a random secret:
--        openssl rand -hex 32
--   2. Set it on the edge function side (Supabase secrets):
--        tools/supabase.exe secrets set CRON_SECRET=<paste> \
--          --project-ref sdewylbddkcvidwosgxo
--   3. Store the same value in Vault so pg_cron can read it:
--        select vault.create_secret('<paste>', 'cron_secret', 'cron auth');
-- After those three steps, the cron starts firing daily.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Wrapper function so cron payload stays clean. Pulls the secret from Vault
-- at call time (so rotating the secret = updating Vault, no migration churn).
create or replace function public.run_payment_plans_cron()
returns void
language plpgsql
security definer
as $$
declare
  v_secret text;
  v_url    text := 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/payment_plans';
begin
  -- Pull secret. If not set up yet, no-op (idempotent — won't error in fresh env).
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  exception when others then
    raise notice 'cron_secret not in vault yet; skipping payment_plans cron';
    return;
  end;
  if v_secret is null then
    raise notice 'cron_secret not set; skipping payment_plans cron';
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type',   'application/json',
      'x-cron-secret',  v_secret
    ),
    body    := jsonb_build_object('action', 'cron_run')
  );
end;
$$;

-- Schedule: daily at 14:00 UTC = 7am Pacific = 10am Eastern. Captures a
-- single window for both the charge job (anything due that day) and the
-- reminder job (14/7/1 days out). One run a day is enough — installments
-- are not latency-sensitive.
do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'payment_plans_daily'
  ) then
    perform cron.schedule(
      'payment_plans_daily',
      '0 14 * * *',
      $cron$ select public.run_payment_plans_cron(); $cron$
    );
  end if;
end $$;

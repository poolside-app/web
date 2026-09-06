-- =============================================================================
-- auto-renew cron — daily notice + charge sweep
-- =============================================================================
-- Same pattern and the same Vault secret as run_payment_plans_cron; only the
-- action differs. Kept as its own job so a club (or Doug) can pause auto-renew
-- without also stopping installment charges, which are unrelated obligations.
--
-- Runs an hour after the installment job so the two never contend for the same
-- Stripe rate limit window, and so a household that just paid an installment is
-- already marked paid before auto-renew looks at it.
-- =============================================================================

create or replace function public.run_auto_renew_cron()
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret text;
  v_url    text := 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/payment_plans';
begin
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  exception when others then
    raise notice 'cron_secret not in vault yet; skipping auto-renew cron';
    return;
  end;
  if v_secret is null then
    raise notice 'cron_secret not set; skipping auto-renew cron';
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type',  'application/json',
      'x-cron-secret', v_secret
    ),
    body    := jsonb_build_object('action', 'auto_renew_run')
  );
end;
$$;

-- These cron wrappers are only ever meant to be called by pg_cron. Leaving them
-- callable over /rest/v1/rpc/ lets a stranger trigger a club's billing run.
revoke execute on function public.run_auto_renew_cron() from anon, authenticated;

do $$
begin
  if not exists (select 1 from cron.job where jobname = 'auto_renew_daily') then
    perform cron.schedule(
      'auto_renew_daily',
      '0 15 * * *',
      $cron$ select public.run_auto_renew_cron(); $cron$
    );
  end if;
end $$;

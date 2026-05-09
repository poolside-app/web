-- =============================================================================
-- 20260508000300 — gate-bridge offline monitoring
-- =============================================================================
-- Detects when a club's on-site Pi bridge stops checking in and notifies
-- the board (and the provider). Without this, the first sign of a dead
-- bridge is a member trying to unlock the gate and getting the cold
-- shoulder — bad UX and the board has no idea anything's wrong.
--
-- State machine:
--   bridge_alert_state = 'ok'                — bridge is healthy or never
--                                              been online (initial state)
--   bridge_alert_state = 'alerted_offline'   — we already sent the offline
--                                              alert; don't spam
-- Transitions live inside gate_admin.cron_check_bridges:
--   ok           → alerted_offline   when offline >10 min
--   alerted_offline → ok              when bridge phones home again
--
-- Cron cadence: 5 minutes. Plus a 10-min offline threshold means a real
-- outage is detected within 10–15 min. Network blips under 10 min self-
-- recover with no alert noise.
-- =============================================================================

alter table public.gate_panels
  add column if not exists bridge_alert_state text not null default 'ok'
    check (bridge_alert_state in ('ok', 'alerted_offline')),
  add column if not exists bridge_alert_first_offline_at timestamptz,
  add column if not exists bridge_last_alert_at timestamptz;

-- Cron wrapper. Same Vault-driven secret pattern as the other cron jobs.
-- Idempotent: pulls cron_secret on each call, no-ops if missing.
create or replace function public.run_gate_bridge_monitor_cron()
returns void
language plpgsql
security definer
as $$
declare
  v_secret text;
  v_url    text := 'https://sdewylbddkcvidwosgxo.supabase.co/functions/v1/gate_admin';
begin
  begin
    select decrypted_secret into v_secret
      from vault.decrypted_secrets where name = 'cron_secret' limit 1;
  exception when others then
    raise notice 'cron_secret not in vault yet; skipping bridge monitor';
    return;
  end;
  if v_secret is null then
    raise notice 'cron_secret not set; skipping bridge monitor';
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
      'content-type',   'application/json',
      'x-cron-secret',  v_secret
    ),
    body    := jsonb_build_object('action', 'cron_check_bridges')
  );
end;
$$;

-- Schedule every 5 minutes.
do $$
begin
  if not exists (
    select 1 from cron.job where jobname = 'gate_bridge_monitor'
  ) then
    perform cron.schedule(
      'gate_bridge_monitor',
      '*/5 * * * *',
      $cron$ select public.run_gate_bridge_monitor_cron(); $cron$
    );
  end if;
end $$;

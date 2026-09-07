-- =============================================================================
-- 20260906000200 — gate bridge: flap damping
-- =============================================================================
-- A bridge that cycles up-down-up-down produces a complete alert set on every
-- cycle. Three cycles inside two minutes generated sixteen emails during
-- testing on 2026-09-06, which is exactly what a real club would get from a
-- bridge with a dying power supply.
--
-- Flapping is not a rare edge case — it is the NORMAL presentation of most
-- bridge hardware failures. A failing SD card, a marginal PSU, an overheating
-- Pi in a hot equipment room and a loose ethernet cable all look like this.
-- Sixteen "bridge offline" emails tell you nothing; "restarted 4 times in the
-- last hour" tells you to go replace the hardware. The second message is the
-- one worth sending, and it should be sent once.
--
-- Three columns of history, no new table — one row per club, and the only
-- question being asked is "how many times recently".
--
-- Note the club side needs no damping: escalation to the club requires 30
-- CONTINUOUS minutes of silence, and a flapping bridge keeps recovering,
-- which resets the state machine to 'ok'. A flapping bridge therefore never
-- reaches the club at all. This is provider-side noise by construction.
-- =============================================================================

alter table public.gate_panels
  -- Offline transitions seen inside the current rolling window.
  add column if not exists bridge_flap_count int not null default 0,
  -- When that window opened. Null, or older than the window length, means
  -- the next outage starts counting fresh.
  add column if not exists bridge_flap_window_start timestamptz,
  -- When the single "this bridge is flapping" alert was last sent, so a
  -- bridge that flaps for a week doesn't send that one every hour either.
  add column if not exists bridge_flap_alerted_at timestamptz,
  -- When an offline alert was last actually DELIVERED. Distinct from
  -- bridge_provider_alerted_at, which records the state transition whether
  -- or not a message went out — the cooldown has to key off real sends.
  add column if not exists bridge_last_offline_alert_at timestamptz;

comment on column public.gate_panels.bridge_flap_count is
  'Offline transitions inside the current flap window. Read together with bridge_flap_window_start; a stale window means the count is expired, not current.';

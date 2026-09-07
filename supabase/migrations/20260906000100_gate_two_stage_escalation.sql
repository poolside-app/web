-- =============================================================================
-- 20260906000100 — gate bridge: two-stage outage escalation
-- =============================================================================
-- Replaces the single-stage alert added in 20260508000300. That version told
-- the club and the provider at the same instant, 10 minutes into an outage.
-- In practice most outages are a router blip or a short power flicker that
-- clears on its own, so the club was being alarmed about problems that had
-- already fixed themselves by the time anyone read the email.
--
-- New shape — the provider gets a quiet head start:
--
--   ok               --  10 min silent --> alerted_provider   (Doug only)
--   alerted_provider --  30 min silent --> alerted_club       (text the club)
--   either           --  bridge returns --> ok
--
-- The point of the middle state: if the bridge recovers before the 30-minute
-- mark, the club never learns anything was wrong. Doug fixes it (or it heals
-- itself) and the outage is invisible to the customer. That gap is the thing
-- the monitoring subscription is actually selling.
--
-- Recovery messaging keys off which state we're leaving. Coming back from
-- alerted_provider notifies Doug only — sending a club an "all clear" for an
-- outage they were never told about just creates a support question.
--
-- Reply capture: the club's text carries a one-tap link. Their answer lands
-- in bridge_outage_reply and tells Doug whether to expect a site visit or
-- wait out a utility outage. Nullable and advisory; nothing depends on it.
-- =============================================================================

-- ── State machine: widen the allowed values ──────────────────────────────
-- The old constraint was created inline by the previous migration, so its
-- name is Postgres-generated. Drop whatever check currently guards the
-- column rather than guessing at the name.
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
     where nsp.nspname = 'public'
       and rel.relname = 'gate_panels'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%bridge_alert_state%'
  loop
    execute format('alter table public.gate_panels drop constraint %I', c.conname);
  end loop;
end $$;

-- Existing rows sitting in the old terminal state have, by definition,
-- already had their club notified. Land them in alerted_club so the state
-- machine doesn't re-text a club about an outage it already knows about.
update public.gate_panels
   set bridge_alert_state = 'alerted_club'
 where bridge_alert_state = 'alerted_offline';

alter table public.gate_panels
  add constraint gate_panels_bridge_alert_state_check
  check (bridge_alert_state in ('ok', 'alerted_provider', 'alerted_club'));

-- ── Escalation timestamps ────────────────────────────────────────────────
-- Separate columns rather than reusing bridge_last_alert_at, because the
-- cron needs to answer "has the club been told yet?" independently of
-- "when did we last send anything?".
alter table public.gate_panels
  add column if not exists bridge_provider_alerted_at timestamptz,
  add column if not exists bridge_club_alerted_at     timestamptz;

-- ── Club's one-tap reply to the outage text ──────────────────────────────
alter table public.gate_panels
  add column if not exists bridge_outage_reply text
    check (bridge_outage_reply in ('power_outage', 'please_check')),
  add column if not exists bridge_outage_reply_at timestamptz;

-- ── How the bridge reaches the internet ──────────────────────────────────
-- Wired ethernet is a requirement, not a preference: Wi-Fi introduces a
-- failure mode (password rotated, AP moved, channel congestion at a busy
-- pool) that is invisible from the cloud and indistinguishable from a dead
-- bridge. Recorded per-panel so an install that quietly went wireless is
-- visible on the provider dashboard instead of being discovered mid-outage.
alter table public.gate_panels
  add column if not exists bridge_link_type text not null default 'unknown'
    check (bridge_link_type in ('wired', 'wifi', 'cellular', 'unknown'));

comment on column public.gate_panels.bridge_link_type is
  'Physical uplink for the bridge. Wired is required for new installs; wifi is a support liability and should be flagged.';

-- Partial index: the cron scans only panels that are active AND not already
-- in a settled state, which is nearly all of them nearly all of the time.
create index if not exists gate_panels_alert_state_idx
  on public.gate_panels (bridge_alert_state)
  where status = 'active';

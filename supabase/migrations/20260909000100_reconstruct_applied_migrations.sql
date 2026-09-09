-- =============================================================================
-- reconstruct_applied_migrations — put five live changes back into the repo
-- =============================================================================
-- Between 2026-09-06 and 2026-09-08 five schema changes were applied straight
-- to production through the management API and never written down here:
--
--   sms_segment_metering          sms_log.segments + spend_sms_credits()
--   tenants_desired_plan          tenants.desired_plan
--   tenants_trial_notice_tracking tenants.trial_notice_stage
--   applications_wants_auto_renew applications.wants_auto_renew
--   installment_plan_fee          payment_plan_installments.plan_fee_cents
--   member_login_code_attempts    member_magic_links.code_attempts
--
-- The consequence was not visible while only production existed: the repo no
-- longer described the database. A fresh environment built from migrations
-- would be missing columns that four Edge Functions already read and write,
-- and a Supabase branch — which section 03 of the readiness board wants CI
-- pointed at — would fail on the first query rather than at deploy time.
--
-- This file is RECONSTRUCTED FROM THE FUNCTION CODE, not dumped from the live
-- schema, because the project was restricted when it was written. Every
-- statement is `if not exists` / `or replace`, so against production it is a
-- no-op that simply records what is already true. If a type here disagrees
-- with the live column, production wins and this file should be corrected —
-- check with \d once the project is reachable again.
-- =============================================================================

-- ── sms_segment_metering ────────────────────────────────────────────────────
-- Twilio bills per 160-char GSM-7 segment (70 on UCS-2), so a long or
-- emoji-carrying message costs several sends. The cap counts segments, not
-- rows. Defaults to 1 so any caller that does not measure undercounts rather
-- than over-charging the club.
alter table public.sms_log
  add column if not exists segments int not null default 1;

alter table public.sms_log
  drop constraint if exists sms_log_segments_positive;
alter table public.sms_log
  add constraint sms_log_segments_positive check (segments >= 1);

-- sms_log dates its rows with sent_at, not created_at. The cap query scans
-- a tenant's sends for the current calendar year, so it wants both columns.
create index if not exists sms_log_tenant_sent_idx
  on public.sms_log (tenant_id, sent_at desc);

-- Spend purchased credits, denominated in segments. Returns how many were
-- actually taken, which may be fewer than asked for when the balance is short.
--
-- Guarded rather than `create or replace`: this function already exists in
-- production from the migration that was never written down, and the body
-- below is reconstructed from its call site, not copied from the live
-- definition. Replacing a working function with a guess is the one thing
-- this file must not do — so it is only created if genuinely absent.
do $guard$
begin
  if not exists (
    select 1 from pg_proc pr
      join pg_namespace n on n.oid = pr.pronamespace
     where n.nspname = 'public' and pr.proname = 'spend_sms_credits'
  ) then
    execute $fn$
      create function public.spend_sms_credits(p_tenant uuid, p_n int)
      returns int
      language plpgsql
      security definer
      set search_path = public
      as $body$
      declare
        available int;
        spent     int;
      begin
        if p_n is null or p_n <= 0 then
          return 0;
        end if;

        -- for update: two sends landing together must not both spend the
        -- same credit and drive the balance negative.
        select sms_credits into available
          from public.tenants
         where id = p_tenant
           for update;

        if available is null then
          return 0;
        end if;

        spent := least(p_n, greatest(0, available));

        if spent > 0 then
          update public.tenants
             set sms_credits = sms_credits - spent
           where id = p_tenant;
        end if;

        return spent;
      end;
      $body$;
    $fn$;

    revoke all on function public.spend_sms_credits(uuid, int) from public, anon, authenticated;
    grant execute on function public.spend_sms_credits(uuid, int) to service_role;
  end if;
end
$guard$;

-- ── tenants_desired_plan ────────────────────────────────────────────────────
-- What the club picked at signup, before any money changes hands. Distinct
-- from the plan they are actually on: during the free first season every
-- tenant runs uncapped regardless of what they chose.
alter table public.tenants
  add column if not exists desired_plan text;

alter table public.tenants
  drop constraint if exists tenants_desired_plan_known;
-- not valid: this column predates the migration file and production may
-- hold 'free' from before that tier was retired. The constraint should
-- govern new writes without the migration failing on old rows. Validate it
-- by hand once the legacy values have been cleaned up.
alter table public.tenants
  add constraint tenants_desired_plan_known
  check (desired_plan is null or desired_plan in ('starter', 'pro', 'enterprise'))
  not valid;

-- ── tenants_trial_notice_tracking ───────────────────────────────────────────
-- Which "your free season is ending" notice has already gone out, so the cron
-- can run daily without mailing the same club every morning.
alter table public.tenants
  add column if not exists trial_notice_stage text;

alter table public.tenants
  drop constraint if exists tenants_trial_notice_stage_known;
-- not valid, for the same reason: the cron writes t30/t7/expired today, but
-- this column has been live longer than this file has existed.
alter table public.tenants
  add constraint tenants_trial_notice_stage_known
  check (trial_notice_stage is null
         or trial_notice_stage in ('t30', 't14', 't7', 't1', 'expired'))
  not valid;

-- ── applications_wants_auto_renew ───────────────────────────────────────────
-- Ticked at signup: charge the saved card next season rather than making the
-- household re-apply. Read when the application is approved and copied onto
-- the household.
alter table public.applications
  add column if not exists wants_auto_renew boolean not null default false;

-- ── installment_plan_fee ────────────────────────────────────────────────────
-- The member's convenience fee for spreading dues across the season: $4 a
-- payment, capped at $16 a plan. Deliberately NOT folded into amount_cents —
-- installments stay the pure dues figure so the club's books are identical
-- whether a household pays once or six times. The fee rides alongside and is
-- added to application_fee_amount, so it reaches the platform, not the club.
alter table public.payment_plan_installments
  add column if not exists plan_fee_cents int not null default 0;

alter table public.payment_plan_installments
  drop constraint if exists payment_plan_installments_plan_fee_nonneg;
alter table public.payment_plan_installments
  add constraint payment_plan_installments_plan_fee_nonneg
  check (plan_fee_cents >= 0);

-- ── member_login_code_attempts ──────────────────────────────────────────────
-- A 6-digit code is 1,000,000 possibilities, which is not many when a phone
-- number is the only other factor. Five wrong guesses burns the code.
alter table public.member_magic_links
  add column if not exists code_attempts int not null default 0;

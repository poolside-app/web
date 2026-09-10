-- =============================================================================
-- resend_quota_header — use Resend's own count instead of guessing
-- =============================================================================
-- Resend returns `x-resend-daily-quota` on every send for free-plan accounts:
-- how many of the day's 100 emails have been used. That is authoritative, and
-- better than counting our own sends, which only ever produced a floor —
-- three separate code paths send email here and not all of them log.
--
-- Recorded per send so the most recent reading is always available, and so a
-- disagreement between our count and Resend's is visible rather than assumed
-- away. Null for paid plans, which have no daily quota, and for sends that
-- never reached Resend.
-- =============================================================================

alter table public.email_log
  add column if not exists provider_quota_used int;

-- The budget reads the newest non-null value for today, so it wants the
-- newest rows that have one.
create index if not exists email_log_quota_idx
  on public.email_log (sent_at desc)
  where provider_quota_used is not null;

comment on column public.email_log.provider_quota_used is
  'x-resend-daily-quota at the moment of this send — emails used today per Resend. Null on paid plans and on sends that never reached them.';

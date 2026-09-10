-- =============================================================================
-- referral_board_approval — a person decides, every time
-- =============================================================================
-- Cash refunds already required a board member with the payments scope. The
-- "discount next season" reward did not: a member claimed it and the credit
-- was written to households.referral_credits_cents on the spot, with nobody
-- asked. It is not money leaving a bank account, but it is a standing
-- reduction in what the club will collect next year, decided entirely by the
-- person receiving it.
--
-- So: nothing is applied until a board member approves it. The member's claim
-- becomes a request. A club that wants to say no — the referral looks like a
-- family who was joining anyway, the neighbor is the referrer's own adult
-- child, the board simply cannot afford six free memberships this year — can
-- say no, with a reason, and the member is told.
--
-- 'claimed' sits between verified and rewarded: the member has chosen their
-- reward and nothing has happened yet.
-- =============================================================================

alter table public.referrals
  drop constraint if exists referrals_status_check;
alter table public.referrals
  add constraint referrals_status_check
  check (status in ('applied', 'verified', 'claimed', 'rewarded', 'rejected', 'declined'));

alter table public.referrals
  add column if not exists approved_by      uuid,
  add column if not exists approved_at      timestamptz,
  add column if not exists declined_by      uuid,
  add column if not exists declined_at      timestamptz,
  add column if not exists decline_reason   text;

-- The board's queue: everything waiting on a person, oldest first.
create index if not exists referrals_awaiting_board_idx
  on public.referrals (tenant_id, status, reward_chosen_at)
  where status = 'claimed';

comment on column public.referrals.approved_by is
  'The board member who approved this reward. Nothing is credited or refunded until this is set.';

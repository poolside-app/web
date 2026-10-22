-- =============================================================================
-- Referrals: "Count it anyway" (PLAN.md BJ5)
-- =============================================================================
-- Doug, 2026-10-21: a referral counts only if the new family wasn't a member
-- last season (_shared/referral_eligibility.ts). The board sees the ones that
-- don't, with why ("Member in 2026: same address as the Smith Family"), and a
-- board member with the payments permission can count one anyway. Who did,
-- and when, is kept; once set, the rule isn't checked again when they pay.
-- =============================================================================

alter table public.referrals
  add column if not exists override_by uuid references public.admin_users(id) on delete set null,
  add column if not exists override_by_name text,
  add column if not exists override_at timestamptz;

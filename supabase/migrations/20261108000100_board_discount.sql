-- PLAN.md CO (Doug 11/8): a membership discount for each board member, set on
-- the Board page, taken off their own family's dues.
alter table public.admin_users add column if not exists member_discount_pct integer not null default 0;
do $$ begin
  alter table public.admin_users add constraint admin_users_member_discount_pct_check
    check (member_discount_pct between 0 and 100);
exception when duplicate_object then null; end $$;

-- A signup a board member started from their board home ("Sign up your own
-- family"), so their discount applies before their family is linked.
alter table public.applications add column if not exists board_admin_id uuid
  references public.admin_users(id) on delete set null;

-- 'board' joins 'code' and 'referral' as the one discount that counts.
alter table public.applications drop constraint if exists applications_discount_kind_check;
alter table public.applications add constraint applications_discount_kind_check
  check (discount_kind = any (array['code'::text, 'referral'::text, 'board'::text]));

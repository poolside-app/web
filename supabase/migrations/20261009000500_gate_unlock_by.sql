-- =============================================================================
-- Who opened the gate from the board home (PLAN.md W2)
-- =============================================================================
-- Doug, 10/9: the unlock goes at the top of every board member's home, not
-- only the President's. Each tap is logged with the board member who made
-- it: gate_unlocks.admin_user_id, and a new actor_kind 'admin' (a real
-- unlock, as opposed to 'admin_test' from Settings).
-- =============================================================================

alter table public.gate_unlocks
  add column if not exists admin_user_id uuid references public.admin_users(id) on delete set null;

alter table public.gate_unlocks
  drop constraint if exists gate_unlocks_actor_kind_check;

alter table public.gate_unlocks
  add constraint gate_unlocks_actor_kind_check
  check (actor_kind in ('member', 'admin', 'admin_test', 'provider_test', 'system'));

create index if not exists gate_unlocks_admin_user_idx on public.gate_unlocks (admin_user_id, requested_at desc)
  where admin_user_id is not null;

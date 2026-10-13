-- PLAN.md AS3: a pass can go to a guest (anyone by name and mobile: a
-- landscaper, the pool tech, a volunteer who isn't a member). Their text
-- has a private link; only its sha256 is stored. Guest unlocks are logged
-- as 'guest' with the pass.

alter table public.access_passes alter column household_id drop not null;
alter table public.access_passes
  add column if not exists guest_name text,
  add column if not exists guest_phone text,
  add column if not exists token_hash text,
  add column if not exists texted_at timestamptz;
create unique index if not exists access_passes_token on public.access_passes (token_hash) where token_hash is not null;
alter table public.access_passes drop constraint if exists access_passes_who;
alter table public.access_passes add constraint access_passes_who
  check (household_id is not null or (guest_name is not null and guest_phone is not null and token_hash is not null));

alter table public.gate_unlocks drop constraint if exists gate_unlocks_actor_kind_check;
alter table public.gate_unlocks add constraint gate_unlocks_actor_kind_check
  check (actor_kind = any (array['member', 'admin', 'admin_test', 'provider_test', 'system', 'guest']));

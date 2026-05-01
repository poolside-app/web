-- =============================================================================
-- admin_magic_links — passwordless sign-in for tenant admins
-- =============================================================================
-- Mirrors member_magic_links. Generated when an admin requests an email
-- or SMS sign-in link via tenant_admin_auth.start_link. Single-use,
-- 15-minute TTL, hashed at rest.
-- =============================================================================

create table if not exists public.admin_magic_links (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id)    on delete cascade,
  admin_user_id uuid not null references public.admin_users(id) on delete cascade,
  token_hash    text not null,
  expires_at    timestamptz not null,
  used_at       timestamptz,
  used_ip       text,
  created_at    timestamptz not null default now()
);

create unique index if not exists admin_magic_links_token_idx
  on public.admin_magic_links(token_hash);
create index if not exists admin_magic_links_admin_open_idx
  on public.admin_magic_links(admin_user_id, used_at) where used_at is null;

alter table public.admin_magic_links enable row level security;
drop policy if exists admin_magic_links_service on public.admin_magic_links;
create policy admin_magic_links_service on public.admin_magic_links for all using (true) with check (true);

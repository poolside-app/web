-- =============================================================================
-- member_magic_links — One-time login tokens for member-facing magic-link auth
-- =============================================================================
-- The raw token is never persisted — only its SHA-256 hex digest. Fifteen-
-- minute expiry, single-use (used_at flips on consumption). Rows are kept
-- around for audit; a future cleanup job can drop entries with used_at or
-- expires_at older than e.g. 30 days.
-- =============================================================================

create table if not exists public.member_magic_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  member_id uuid not null references public.household_members(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists member_magic_links_token_idx on public.member_magic_links(token_hash);
create index if not exists member_magic_links_member_idx on public.member_magic_links(member_id, created_at desc);
alter table public.member_magic_links enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'member_magic_links' and policyname = 'member_magic_links_service_role'
  ) then
    create policy member_magic_links_service_role on public.member_magic_links for all using (true) with check (true);
  end if;
end $$;

-- =============================================================================
-- posts — Per-tenant announcements/news. Shown on the public landing page.
-- =============================================================================
-- Soft-delete via active=false. Pinned posts surface above non-pinned in the
-- index used by the public landing page. created_by is nullable so synthetic
-- impersonation tokens can write posts without forcing a fake admin_users row.
-- =============================================================================

create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null,
  body text not null,
  pinned boolean not null default false,
  published_at timestamptz not null default now(),
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists posts_tenant_published_idx
  on public.posts(tenant_id, pinned desc, published_at desc)
  where active = true;

alter table public.posts enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'posts' and policyname = 'posts_service_role'
  ) then
    create policy posts_service_role on public.posts for all using (true) with check (true);
  end if;
end $$;

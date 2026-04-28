-- =============================================================================
-- photos — Per-tenant photo gallery (uploaded via tenant_upload to the
-- club-assets Supabase Storage bucket)
-- =============================================================================
-- url is the public CDN URL. sort_order lets admins reorder; created_at
-- breaks ties so default order is "most recently uploaded first".
-- =============================================================================

create table if not exists public.photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  url text not null,
  caption text,
  sort_order int not null default 0,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists photos_tenant_sort_idx
  on public.photos(tenant_id, sort_order asc, created_at desc)
  where active = true;

alter table public.photos enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'photos' and policyname = 'photos_service_role'
  ) then
    create policy photos_service_role on public.photos for all using (true) with check (true);
  end if;
end $$;

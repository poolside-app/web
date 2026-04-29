-- =============================================================================
-- documents — Per-tenant file uploads (handbook, applications, financial docs)
-- =============================================================================
-- visibility = 'public'  → surfaces on the public landing page
--            = 'members' → only signed-in members see it
--            = 'admins'  → admin-only (board minutes, etc.)
-- The actual file lives in the club-assets Storage bucket (also bumped to
-- 25 MB and now allows application/pdf).
-- =============================================================================

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null,
  description text,
  url text not null,
  visibility text not null default 'public',
  sort_order int not null default 0,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_visibility_chk check (visibility in ('public','members','admins'))
);

create index if not exists documents_tenant_idx
  on public.documents(tenant_id, sort_order asc, created_at desc)
  where active = true;

alter table public.documents enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'documents' and policyname = 'documents_service_role'
  ) then
    create policy documents_service_role on public.documents for all using (true) with check (true);
  end if;
end $$;

-- Bucket update: allow PDFs alongside images, raise size cap to 25 MB
update storage.buckets
   set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif','application/pdf'],
       file_size_limit = 26214400
 where id = 'club-assets';

-- =============================================================================
-- events — Per-tenant calendar entries: parties, swim meets, closures, etc.
-- =============================================================================
-- Surfaces on the public landing page (next few upcoming) and on the admin
-- calendar tab. Soft-delete via active=false. Kind constrained so the UI can
-- map to deterministic icons / colors.
-- =============================================================================

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  title text not null,
  body text,
  kind text not null default 'event',
  location text,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  active boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_kind_chk check (kind in (
    'event','party','swim_meet','social','closure','holiday','lesson','meeting'
  )),
  constraint events_ends_after_starts_chk check (ends_at is null or ends_at >= starts_at)
);

create index if not exists events_tenant_starts_idx
  on public.events(tenant_id, starts_at) where active = true;

alter table public.events enable row level security;

do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'events' and policyname = 'events_service_role'
  ) then
    create policy events_service_role on public.events for all using (true) with check (true);
  end if;
end $$;

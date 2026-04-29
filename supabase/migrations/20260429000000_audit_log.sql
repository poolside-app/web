-- =============================================================================
-- audit_log — Per-tenant ledger of meaningful writes
-- =============================================================================
-- Every Edge Function that does a write should append a row here so admins
-- (and Doug for support) can answer "who changed what, when?". Service role
-- writes bypass RLS; the audit_admin Edge Function reads it back scoped to
-- the caller's tenant.
-- =============================================================================

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null,            -- e.g. 'household.create', 'application.approve'
  entity_type text not null,     -- 'household' | 'event' | 'post' | 'application' | etc.
  entity_id uuid,                -- the row that was touched (when applicable)
  summary text,                  -- human-readable one-liner for the timeline
  actor_id uuid,                 -- admin_users.id, household_members.id, or provider_admins.id
  actor_kind text,               -- 'tenant_admin' | 'member' | 'provider' | 'public'
  actor_label text,              -- pre-resolved name/email for display
  metadata jsonb,                -- arbitrary extra context
  created_at timestamptz not null default now()
);

create index if not exists audit_log_tenant_time_idx
  on public.audit_log(tenant_id, created_at desc);
create index if not exists audit_log_entity_idx
  on public.audit_log(tenant_id, entity_type, entity_id);

alter table public.audit_log enable row level security;
do $$ begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'audit_log' and policyname = 'audit_log_service_role'
  ) then
    create policy audit_log_service_role on public.audit_log for all using (true) with check (true);
  end if;
end $$;

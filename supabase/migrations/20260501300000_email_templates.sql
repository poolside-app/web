-- =============================================================================
-- email_templates — tenant-customizable subject + body for system emails
-- =============================================================================
-- The system ships with default templates registered in code (single source
-- of truth in _shared/email_template.ts). When an admin edits a template in
-- the Emails admin page, a row is upserted here. renderAndSend() reads the
-- override if present, otherwise renders the default. `enabled=false` lets
-- admin suppress an entire email type without rewriting the body.
-- =============================================================================

create table if not exists public.email_templates (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants(id) on delete cascade,
  key         text not null,                   -- e.g. 'application_received'
  subject     text not null,
  body_html   text not null,
  enabled     boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,
  unique(tenant_id, key)
);

create index if not exists email_templates_tenant_idx
  on public.email_templates(tenant_id, key);

alter table public.email_templates enable row level security;
drop policy if exists email_templates_service on public.email_templates;
create policy email_templates_service on public.email_templates for all using (true) with check (true);

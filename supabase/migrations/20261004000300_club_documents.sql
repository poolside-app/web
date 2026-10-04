-- =============================================================================
-- club_documents — the bylaws, public, next to the minutes (PLAN.md K6)
-- =============================================================================
-- Doug, 2026-10-04: a place on the app for the bylaws, always public, near the
-- board minutes. The President or the Secretary uploads a PDF on the Board
-- minutes page; it shows at the top of the public "Bylaws & board minutes"
-- page. Each upload is a new row, so earlier versions stay with their dates.
-- The files live in the public club-assets bucket (tenant_upload).
-- =============================================================================

create table if not exists public.club_documents (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  kind              text not null check (kind in ('bylaws')),
  url               text not null,
  file_name         text,
  uploaded_by       uuid references public.admin_users(id) on delete set null,
  uploaded_by_name  text,
  uploaded_at       timestamptz not null default now()
);
create index if not exists club_documents_tenant_idx on public.club_documents(tenant_id, kind, uploaded_at desc);
alter table public.club_documents enable row level security;

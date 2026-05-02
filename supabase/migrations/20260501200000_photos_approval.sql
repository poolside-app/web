-- =============================================================================
-- photos approval workflow — let members submit photos that admins approve
-- =============================================================================
-- Existing photos default to status='approved' so nothing currently public
-- gets hidden by this migration. New member-submitted photos land as
-- 'pending' until an admin approves or rejects.
-- =============================================================================

alter table public.photos
  add column if not exists status text not null default 'approved'
    check (status in ('approved','pending','rejected'));
alter table public.photos
  add column if not exists uploaded_by_kind text not null default 'admin'
    check (uploaded_by_kind in ('admin','member'));
alter table public.photos
  add column if not exists uploaded_by_member_id uuid;
alter table public.photos
  add column if not exists uploader_name text;
alter table public.photos
  add column if not exists approved_at timestamptz;
alter table public.photos
  add column if not exists approved_by uuid;
alter table public.photos
  add column if not exists rejected_at timestamptz;
alter table public.photos
  add column if not exists rejected_by uuid;
alter table public.photos
  add column if not exists rejected_reason text;

-- Hot path: filter to approved when rendering public + member galleries.
create index if not exists photos_tenant_status_idx
  on public.photos(tenant_id, status, sort_order asc, created_at desc)
  where active = true;

-- Pending-queue index for admin approval list
create index if not exists photos_pending_idx
  on public.photos(tenant_id, created_at desc)
  where active = true and status = 'pending';

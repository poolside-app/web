-- =============================================================================
-- feedback_submissions + sponsors — Bishop-parity surfaces
-- =============================================================================
-- Three new persistent surfaces that previously lived only on Bishop Estates:
--   1. Anonymous feedback box     → feedback_submissions
--   2. Sponsor program            → sponsors
--   3. Fundraiser thermometer     → settings.value.fundraiser  (no DB table)
--   4. Season-open toggle/dates   → settings.value.season      (no DB table)
--   5. Apply page H1 override     → settings.value.apply       (no DB table)
--   6. Member-count ticker on/off → settings.value.public      (no DB table)
-- =============================================================================

-- ── Anonymous feedback ───────────────────────────────────────────────────
-- Members or any visitor can submit a photo + comment from the public or
-- member home. Submission goes anonymously to the admin's notify list. No
-- foreign key to households — preserving "I don't want to attach my name"
-- as a feature, not a bug. ip_hash stops a single bad actor from spamming.
create table if not exists public.feedback_submissions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  photo_url     text,
  comment       text not null check (length(comment) between 1 and 2000),
  ip_hash       text,
  status        text not null default 'new' check (status in ('new','in_progress','resolved','spam')),
  admin_notes   text,
  resolved_at   timestamptz,
  resolved_by   uuid references public.admin_users(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists feedback_tenant_status_idx
  on public.feedback_submissions(tenant_id, status);
create index if not exists feedback_tenant_created_idx
  on public.feedback_submissions(tenant_id, created_at desc);

-- ── Sponsors ─────────────────────────────────────────────────────────────
-- Local businesses that paid for a sponsorship slot. Surface in two places:
-- a strip of logos at the top of public + member home, and a configurable
-- pop-up that rotates through them on app load. paid_through is informational
-- only — the public surface filters by active=true so admin pulls the row
-- when payment lapses.
create table if not exists public.sponsors (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  name          text not null,
  logo_url      text,
  link_url      text,
  description   text,
  tier          text not null default 'basic' check (tier in ('basic','premium')),
  paid_through  date,
  sort_order    int  not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists sponsors_tenant_active_idx
  on public.sponsors(tenant_id, active, sort_order);

create or replace function public.fn_sponsors_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists sponsors_updated_at on public.sponsors;
create trigger sponsors_updated_at
  before update on public.sponsors
  for each row execute function public.fn_sponsors_touch_updated_at();

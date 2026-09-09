-- =============================================================================
-- gate_integration_requests — "tell us what you have and we'll call you"
-- =============================================================================
-- Replaces the model this add-on was originally designed around. That design
-- was a catalogue of verified panel templates: a club picked its panel from a
-- published compatibility list and got a one-click install. Two problems with
-- it, both structural:
--
--   1. A published list is a promise. Every entry on it is something we have
--      to keep working across firmware revisions, and every club whose panel
--      is NOT on it reads the list as "you don't support me" and leaves.
--   2. Every new panel became a research project before we could quote it,
--      which does not scale past the panels one person can personally test.
--
-- The replacement makes no promise at all. A club ticks a box, tells us what
-- it has in whatever detail it happens to know, attaches photos, and we call
-- them. The catalogue disappears; triage happens per request, by a human, on
-- the evidence. Nothing is quoted before someone has actually looked.
--
-- Deliberately: every field describing the hardware is nullable. The board
-- treasurer who has no idea what brand the panel is — who is the single most
-- likely person to fill this in — must be able to submit photos and nothing
-- else and still get a phone call.
-- =============================================================================

create table if not exists public.gate_integration_requests (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,

  -- Who to call back. The only genuinely required information: this whole
  -- feature exists to produce a phone call.
  contact_name          text not null,
  contact_phone         text not null,
  contact_email         text,
  best_time_to_call     text,

  -- What they have. All optional on purpose — see the note above.
  manufacturer          text,
  model                 text,
  door_count            int,
  link_type             text,
  existing_system       text,        -- free text: what is on the gate today
  what_they_want        text,        -- free text: what they are hoping for

  -- Photos of the panel, the reader and the install. Public URLs in the
  -- club-assets bucket, same upload path as feedback submissions.
  photo_urls            text[] not null default '{}',

  -- Provider-side triage.
  status                text not null default 'submitted',
  admin_notes           text,
  quoted_setup_cents    int,
  quoted_monthly_cents  int,
  reviewed_at           timestamptz,
  decided_at            timestamptz,

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

alter table public.gate_integration_requests
  drop constraint if exists gate_integration_requests_status_known;
alter table public.gate_integration_requests
  add constraint gate_integration_requests_status_known
  check (status in ('submitted', 'reviewing', 'call_scheduled',
                    'quoted', 'accepted', 'declined', 'withdrawn'));

alter table public.gate_integration_requests
  drop constraint if exists gate_integration_requests_link_type_known;
alter table public.gate_integration_requests
  add constraint gate_integration_requests_link_type_known
  check (link_type is null
         or link_type in ('wired', 'wifi', 'cellular', 'unknown'));

alter table public.gate_integration_requests
  drop constraint if exists gate_integration_requests_door_count_sane;
alter table public.gate_integration_requests
  add constraint gate_integration_requests_door_count_sane
  check (door_count is null or (door_count >= 1 and door_count <= 50));

-- At most eight photos. Not a storage concern — a review queue where one
-- request carries ninety images is a review queue nobody opens.
alter table public.gate_integration_requests
  drop constraint if exists gate_integration_requests_photo_limit;
alter table public.gate_integration_requests
  add constraint gate_integration_requests_photo_limit
  check (array_length(photo_urls, 1) is null or array_length(photo_urls, 1) <= 8);

create index if not exists gate_integration_requests_tenant_idx
  on public.gate_integration_requests (tenant_id, created_at desc);
create index if not exists gate_integration_requests_status_idx
  on public.gate_integration_requests (status, created_at desc);

-- One live request per club. A second "we'd like the gate please" while the
-- first is still being reviewed is not new information, and two open rows
-- for one club is how a queue starts lying about its own length. Terminal
-- states (accepted / declined / withdrawn) are excluded, so a club that was
-- declined on an old panel can ask again after replacing it.
create unique index if not exists gate_integration_requests_one_open
  on public.gate_integration_requests (tenant_id)
  where status in ('submitted', 'reviewing', 'call_scheduled', 'quoted');

alter table public.gate_integration_requests enable row level security;
drop policy if exists gate_integration_requests_service_role
  on public.gate_integration_requests;
create policy gate_integration_requests_service_role
  on public.gate_integration_requests
  for all to service_role using (true) with check (true);

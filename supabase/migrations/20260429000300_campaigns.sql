-- =============================================================================
-- campaigns — In-app pop-up modals on member app open
-- =============================================================================
-- Distinct from posts (which live in a feed): a campaign briefly takes over
-- the screen with a single CTA. Use cases the volunteer board cares about:
--   - "Pool opens Saturday — RSVP for the kickoff barbecue"
--   - "Annual fund drive — donate by 6/30 to keep the snack bar staffed"
--   - "Swim lessons Tuesday signup link — limited spots"
--
-- Members dismiss once and don't see it again that session (we record the
-- dismissal in localStorage; server-side we don't need a per-member table
-- because volunteer boards don't care about per-member impressions).
-- =============================================================================

create table if not exists public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  title         text not null,
  body          text,
  -- emoji / kind hint shown above the title
  emoji         text default '📣',
  kind          text default 'announcement'
                check (kind in ('announcement','event','fundraiser','signup')),
  cta_label     text,
  cta_url       text,
  audience      text default 'members'
                check (audience in ('members','public','both')),
  starts_at     timestamptz not null default now(),
  ends_at       timestamptz,                                       -- null = no auto-expire
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists campaigns_tenant_active_idx on public.campaigns(tenant_id, active, starts_at);

alter table public.campaigns enable row level security;
drop policy if exists campaigns_service_role on public.campaigns;
create policy campaigns_service_role on public.campaigns for all using (true) with check (true);

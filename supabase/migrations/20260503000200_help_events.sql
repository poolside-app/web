-- =============================================================================
-- help_events — product analytics for the admin self-service help center
-- =============================================================================
-- Records discrete actions admins take in the help center: searches, article
-- opens, article closes (with time-on-article), support-email clicks, and
-- floating-button clicks. The point is to answer two questions:
--
--   1. Which articles get opened most? Where do we double down?
--   2. Which searches return zero hits? What's the long tail of unanswered
--      questions we should write articles for?
--
-- Privacy posture:
--   - Admin-side only (no member PII collected)
--   - Search queries capped at 200 chars to discourage logging full PII strings
--   - User-agent stripped to {browser-family} {os} granularity
--   - No IP address stored
--
-- Sample queries (run as service role):
--
--   -- Top viewed articles in last 30 days
--   select article_slug, count(*) as views,
--          round(avg(duration_ms) / 1000.0, 1) as avg_seconds
--   from help_events
--   where event_type = 'article_close'
--     and created_at > now() - interval '30 days'
--   group by article_slug
--   order by views desc;
--
--   -- Searches that returned zero hits — write articles for the top ones
--   select query, count(*) as hits
--   from help_events
--   where event_type = 'no_results'
--     and created_at > now() - interval '30 days'
--   group by query
--   order by hits desc
--   limit 20;
--
--   -- Support-email click-through after viewing an article (failure signal)
--   select article_slug, count(*) as clicks
--   from help_events
--   where event_type = 'support_email_clicked'
--     and article_slug is not null
--     and created_at > now() - interval '30 days'
--   group by article_slug
--   order by clicks desc;
-- =============================================================================

create table if not exists public.help_events (
  id              uuid primary key default gen_random_uuid(),
  event_type      text not null,
  tenant_id       uuid references public.tenants(id) on delete cascade,
  admin_user_id   uuid,
  query           text,
  article_slug    text,
  duration_ms     integer,
  results_count   integer,
  page_referrer   text,
  user_agent      text,
  created_at      timestamptz not null default now(),

  constraint help_events_event_type_check
    check (event_type in (
      'search', 'no_results', 'article_view', 'article_close',
      'support_email_clicked', 'fab_clicked'
    ))
);

create index if not exists help_events_tenant_time_idx
  on public.help_events(tenant_id, created_at desc);
create index if not exists help_events_type_time_idx
  on public.help_events(event_type, created_at desc);
create index if not exists help_events_article_idx
  on public.help_events(article_slug, created_at desc)
  where article_slug is not null;

alter table public.help_events enable row level security;
drop policy if exists help_events_service_role on public.help_events;
create policy help_events_service_role on public.help_events
  for all to service_role using (true) with check (true);

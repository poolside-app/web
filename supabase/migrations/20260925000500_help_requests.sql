-- =============================================================================
-- help_requests — members ask the board for help from the app
-- =============================================================================
-- Doug, 2026-09-25: a member picks a topic (keyfob & gate, membership & dues,
-- parties & events, pool problem, something else), writes a message and can
-- add a photo. It goes to the board member who handles that topic
-- (settings.value.help_topics), or to the president. It stays on their
-- dashboard until solved, and board replies are texted to the member.
--
--   help_requests  one conversation, its status and who has it
--   help_messages  member messages, board replies, and notes like
--                  "Handed to Kristin by Doug"
--   help-photos    private storage; the app shows photos through short-lived
--                  signed links, so only the member and the board see them
--
-- A family's requests go with the family (household delete cascades).
-- Nothing reaches these tables except the help_requests Edge Function, so
-- RLS is on with no policies, like the rest of the schema.
-- =============================================================================

create table if not exists public.help_requests (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants(id) on delete cascade,
  household_id      uuid references public.households(id) on delete cascade,
  member_id         uuid references public.household_members(id) on delete set null,
  topic             text not null check (topic in ('keyfob', 'membership', 'parties', 'facility', 'other')),
  status            text not null default 'open' check (status in ('open', 'in_progress', 'solved')),
  assigned_admin_id uuid references public.admin_users(id) on delete set null,   -- null = the president
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  solved_at         timestamptz,
  solved_by         uuid references public.admin_users(id) on delete set null
);
create index if not exists help_requests_tenant_idx on public.help_requests(tenant_id, status, updated_at desc);
create index if not exists help_requests_member_idx on public.help_requests(member_id, updated_at desc);
create index if not exists help_requests_assignee_idx on public.help_requests(assigned_admin_id) where status <> 'solved';

create table if not exists public.help_messages (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  request_id       uuid not null references public.help_requests(id) on delete cascade,
  author_kind      text not null check (author_kind in ('member', 'board', 'note')),
  author_member_id uuid references public.household_members(id) on delete set null,
  author_admin_id  uuid references public.admin_users(id) on delete set null,
  body             text not null,
  photo_path       text,                -- in the help-photos bucket
  sent_by          text check (sent_by in ('text', 'email')),   -- how a board reply reached the member
  send_error       text,                -- why it didn't
  created_at       timestamptz not null default now()
);
create index if not exists help_messages_request_idx on public.help_messages(request_id, created_at);

alter table public.help_requests enable row level security;
alter table public.help_messages enable row level security;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('help-photos', 'help-photos', false, 8388608, array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do nothing;

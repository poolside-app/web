-- =============================================================================
-- board_positions — the club's board positions, and alerts by position (K1, K3)
-- =============================================================================
-- Doug, 2026-10-04: each club has its own board positions with job
-- descriptions, editable at setup and any time after. A position decides
-- what its holder can use in the app (positions replaced the fixed roles)
-- and which alerts they get. One person can hold several positions (the
-- Vice-President is a second title); a position can have several holders.
--
--   board_positions          title, purpose, job description, the alerts it
--                            gets (notices), the screens it can use (scopes),
--                            and full_access for the President
--   board_position_holders   who holds which position
--   admin_tasks.notice       which alert a dashboard task is; whoever holds a
--                            position with it now sees it and gets the pop-up
--
-- Bishop Estates is seeded with Doug's positions word for word, Doug as
-- President, and the club-wide spending rule. New clubs get a starter set from
-- _shared/positions.ts when they sign up. Nothing reaches these tables except
-- Edge Functions, so RLS is on with no policies, like the rest of the schema.
-- =============================================================================

create table if not exists public.board_positions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  slug         text not null,
  title        text not null check (length(title) between 1 and 80),
  purpose      text,
  description  text,
  notices      text[] not null default '{}',
  scopes       text[] not null default '{}',
  full_access  boolean not null default false,
  sort         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, slug)
);
create index if not exists board_positions_tenant_idx on public.board_positions(tenant_id, sort);
alter table public.board_positions enable row level security;

create table if not exists public.board_position_holders (
  position_id    uuid not null references public.board_positions(id) on delete cascade,
  admin_user_id  uuid not null references public.admin_users(id) on delete cascade,
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  assigned_at    timestamptz not null default now(),
  primary key (position_id, admin_user_id)
);
create index if not exists board_position_holders_tenant_idx on public.board_position_holders(tenant_id);
create index if not exists board_position_holders_admin_idx on public.board_position_holders(admin_user_id);
alter table public.board_position_holders enable row level security;

alter table public.admin_tasks add column if not exists notice text;
create index if not exists admin_tasks_notice_idx on public.admin_tasks(tenant_id, notice) where completed_at is null;

-- ── Bishop Estates ─────────────────────────────────────────────────────
insert into public.board_positions (tenant_id, sort, slug, title, purpose, description, notices, scopes, full_access)
select t.id, v.sort, v.slug, v.title, v.purpose, v.description, v.notices, v.scopes, v.full_access
from public.tenants t,
(values
  (0, 'president', $q$President$q$, $q$Lead the board, keep every director on their list, and be the club's public face.$q$,
   $q$Bylaw duties (Art. IX §4): Preside at meetings, supervise club business, sign contracts the Board has approved, sit on all committees, give members an annual report.
Every month: Set the agenda and run the board meeting. Go around the table for each director's report. Send out the action list (who, what, by when) within two days.
Through the year: Build the budget with the Treasurer in January. Serve as main contact for the county, the insurer and the swim team. Lead the renovation and funding plan. Give the annual report at the October member meeting.
Can do without asking: Speak for the club, sign what the Board approved, close the pool for a safety problem, spend under $50.
Needs board approval: New contracts, dues or policy changes, anything $50 or more.
Not this job: Doing the other directors' tasks. Hand them off.$q$,
   array['help_other']::text[], '{}'::text[], true),
  (1, 'vice_president', $q$Vice-President$q$, $q$A second title held by one of the directors.$q$,
   $q$Bylaw duties (Art. IX §5): Act as President when the President can't.$q$,
   '{}'::text[], '{}'::text[], false),
  (2, 'treasurer', $q$Treasurer$q$, $q$Know where every dollar is, tell the board how long the cash will last, and run membership accounts.$q$,
   $q$Bylaw duties (Art. IX §8): Keep the accounting records, hold and deposit all funds, give receipts.
Every month: Pay bills, reconcile the bank account, and report the balance, income, spending against budget, and months of cash left. Have a second board member look over the bank statement.
Membership: Process applications and renewals, keep the member list and paid status, answer member account questions. Give the Membership & Marketing Director the list of who hasn't renewed.
Through the year: Draft the budget in January. Send renewal invoices. File taxes and state paperwork on time. Present the finances at the October member meeting.
Can do without asking: Pay recurring bills the Board has already approved, spend under $50.
Needs board approval: New vendors, moving money between accounts, anything $50 or more that isn't already approved.$q$,
   array['signups','payments','referrals','help_membership']::text[], array['payments','applications','households','renewals','tiers','audit']::text[], false),
  (3, 'secretary', $q$Secretary$q$, $q$Keep the club's records and make sure meetings and notices are done properly.$q$,
   $q$Bylaw duties (Art. IX §7): Minutes of all member and board meetings, all required notices, custody of records, the member register.
Every month: Send the agenda three days before the meeting and the minutes within a week after. Keep a current copy of the member list from the Treasurer.
Through the year: Send notice of the October annual meeting at least 10 days ahead (Art. VII §3) and track quorum and proxies. Keep bylaws, insurance, permits and contracts in one shared folder.
Can do without asking: Send official notices and member emails, spend under $50.
Needs board approval: Anything that changes the bylaws or club rules, anything $50 or more.$q$,
   '{}'::text[], array['meetings','policies','announcements','directory']::text[], false),
  (4, 'facilities', $q$Facilities Director$q$, $q$Keep the pool, equipment and buildings safe, working and passing inspection.$q$,
   $q$Every week in season: Walk the property with a checklist: gates and latches, safety equipment, lights, leaks, pool equipment. Confirm the pool tech showed up.
Every month: Report what broke, what was fixed, what's coming and what it costs. Keep one repair list ranked by safety, then compliance, then comfort.
Through the year: Run the opening and closing checklists. Track every county inspection item to completion. Organize a spring and a fall volunteer work day. Get two or three quotes on anything over $1,000. Keep a list of members with trade skills.
Can do without asking: Call vendors for quotes, close off anything unsafe, spend under $50.
Needs board approval: New service contracts, anything $50 or more.
Not this job: Doing all the work personally. The job is making sure it gets done.$q$,
   array['gate','help_keyfob','help_facility']::text[], array['check_in','shifts']::text[], false),
  (5, 'grounds', $q$Grounds Director$q$, $q$Make sure the property looks cared for by managing the people who are paid to maintain it.$q$,
   $q$Every week in season: Walk the grounds and bathrooms after the cleaners and landscapers have been there. Check their work against the standard below. Text or call the vendor the same day if something was missed.
Every month: Report to the board: did each vendor show up, was the work acceptable, any problems or supply needs.
Through the year: Be the single contact for the cleaning and landscaping vendors. Schedule extra service before opening day and events. Once a year, review each vendor's price and quality and get a competing quote if either is slipping.
The standard: Lawn mowed and edged, no weeds in the deck or beds, trash emptied, bathrooms clean and stocked. Would a family touring the club today think it's well kept?
Can do without asking: Tell a vendor to redo or fix missed work, spend under $50.
Needs board approval: Changing vendors, changing the service schedule or price, anything $50 or more.$q$,
   array['help_grounds']::text[], '{}'::text[], false),
  (6, 'membership_marketing', $q$Membership & Marketing Director$q$, $q$Bring in new member families, win back past ones, and keep the club visible in the neighborhood.$q$,
   $q$Goal for 2027: 30 new or returning families signed up by June 1. (2026 had 27.)
Time: About 1 to 2 hours a week.
Every week: One post on Nextdoor and the Bishop Estates Facebook group, rotating through four types, each ending with the join link:
   1. A real photo or story from the club (a swim meet, a family, a summer evening).
   2. A progress update: what got fixed and where the money went.
   3. A specific invitation with a date (open house, bring-a-neighbor day, renewal deadline).
   4. A myth-buster: we're not an HOA, anyone nearby can join, here's what it costs.
Every month: Check that the website's prices, dates and join button are current. Send a welcome note and a free guest pass to any home in Bishop Estates that sold that month. Report new sign-ups, inquiries and what was posted.
Through the year: Win-back email to past members in January. Contact every family that hasn't renewed by March 1, using the Treasurer's list. Flyer or door hanger to the roughly 170 non-member homes in March and May.
Can do without asking: Post, email, update the website, contact any current or past member, spend under $50.
Needs board approval: Discounts, new pricing, anything $50 or more.$q$,
   array['photos']::text[], array['households','renewals','announcements','photos','directory']::text[], false),
  (7, 'events_rentals', $q$Events & Rentals Director$q$, $q$Make the club worth belonging to and bring in rental income.$q$,
   $q$Goal for 2027: One event a month from May to September (up from two a year), plus a rental income target set with the Treasurer.
Before the season: Publish the event calendar by April 1, including an open house where non-members can visit.
For each event: Set the date, line up volunteers, and hand the Membership & Marketing Director the details two weeks ahead.
For rentals: Answer inquiries within two days, keep the booking calendar, and collect the fee and signed rules before the date.
Every month: Report events held, turnout, rentals booked and income.
Can do without asking: Schedule events and rentals on open dates, spend under $50.
Needs board approval: Rental prices, non-member rental rules, alcohol or outside vendors, anything $50 or more.$q$,
   array['rentals','help_parties']::text[], array['events','parties','programs','volunteer']::text[], false)
) as v(sort, slug, title, purpose, description, notices, scopes, full_access)
where t.slug = 'bishopestates'
on conflict (tenant_id, slug) do nothing;

-- Doug, the club's full-access login, is President.
insert into public.board_position_holders (position_id, admin_user_id, tenant_id)
select p.id, a.id, p.tenant_id
from public.board_positions p
join public.tenants t on t.id = p.tenant_id and t.slug = 'bishopestates'
join public.admin_users a on a.tenant_id = p.tenant_id and a.active and a.role_template = 'owner'
where p.slug = 'president'
on conflict do nothing;

update public.settings s
   set value = jsonb_set(coalesce(s.value, '{}'::jsonb), '{board}',
         coalesce(s.value->'board', '{}'::jsonb) || jsonb_build_object('spending_rule', 'Under $50, go ahead. $50 or more needs board approval.'))
  from public.tenants t
 where t.id = s.tenant_id and t.slug = 'bishopestates';

-- =============================================================================
-- rls_lockdown — restrict every public.* RLS policy to the service_role
-- =============================================================================
-- Background: 26 tables ship with `for all using (true) with check (true)`
-- and no role restriction, which means the policy applies to PUBLIC (anon
-- + authenticated). Today the browser only ever calls Edge Functions (which
-- use the service role), so this is latent — but the moment any code path
-- hits PostgREST with the publishable key, every tenant's signatures,
-- audit log, payment plan stripe IDs, etc. become world-readable.
--
-- This migration recreates each loose policy with `to service_role`. The
-- service role bypasses RLS anyway, so functionally nothing changes for
-- the Edge Functions. The change closes the latent hole.
--
-- Pattern per table:
--   drop policy if exists <name> on public.<table>;
--   create policy <name> on public.<table> for all to service_role
--     using (true) with check (true);
--
-- If a future feature legitimately needs anon/authenticated access to one
-- of these tables, add an ADDITIONAL named policy scoped to that role with
-- a tenant-scoped predicate — DON'T loosen these.
-- =============================================================================

-- Helper: do block that does the drop+create dance for every loose policy.
do $$
declare
  policies_to_lock record;
begin
  for policies_to_lock in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and roles = '{public}'                  -- the loose 'apply to all' default
      and policyname not like '%service_role%'  -- guard, but we recreate uniformly below
  loop
    execute format(
      'drop policy if exists %I on %I.%I',
      policies_to_lock.policyname,
      policies_to_lock.schemaname,
      policies_to_lock.tablename
    );
  end loop;
end $$;

-- Recreate each of the 26 known loose policies with `to service_role`.
-- Each is wrapped in a do-block with a drop-if-exists for idempotency
-- (in case the dynamic loop above missed any, or this is run twice).

drop policy if exists posts_service_role on public.posts;
create policy posts_service_role on public.posts
  for all to service_role using (true) with check (true);

drop policy if exists events_service_role on public.events;
create policy events_service_role on public.events
  for all to service_role using (true) with check (true);

drop policy if exists member_magic_links_service_role on public.member_magic_links;
create policy member_magic_links_service_role on public.member_magic_links
  for all to service_role using (true) with check (true);

drop policy if exists photos_service_role on public.photos;
create policy photos_service_role on public.photos
  for all to service_role using (true) with check (true);

drop policy if exists party_bookings_service_role on public.party_bookings;
create policy party_bookings_service_role on public.party_bookings
  for all to service_role using (true) with check (true);

drop policy if exists documents_service_role on public.documents;
create policy documents_service_role on public.documents
  for all to service_role using (true) with check (true);

drop policy if exists applications_service_role on public.applications;
create policy applications_service_role on public.applications
  for all to service_role using (true) with check (true);

drop policy if exists application_actions_service_role on public.application_actions;
create policy application_actions_service_role on public.application_actions
  for all to service_role using (true) with check (true);

drop policy if exists audit_log_service_role on public.audit_log;
create policy audit_log_service_role on public.audit_log
  for all to service_role using (true) with check (true);

drop policy if exists programs_service_role on public.programs;
create policy programs_service_role on public.programs
  for all to service_role using (true) with check (true);

drop policy if exists program_bookings_service_role on public.program_bookings;
create policy program_bookings_service_role on public.program_bookings
  for all to service_role using (true) with check (true);

drop policy if exists campaigns_service_role on public.campaigns;
create policy campaigns_service_role on public.campaigns
  for all to service_role using (true) with check (true);

drop policy if exists volunteer_opportunities_service_role on public.volunteer_opportunities;
create policy volunteer_opportunities_service_role on public.volunteer_opportunities
  for all to service_role using (true) with check (true);

drop policy if exists volunteer_signups_service_role on public.volunteer_signups;
create policy volunteer_signups_service_role on public.volunteer_signups
  for all to service_role using (true) with check (true);

drop policy if exists guest_pass_packs_service_role on public.guest_pass_packs;
create policy guest_pass_packs_service_role on public.guest_pass_packs
  for all to service_role using (true) with check (true);

drop policy if exists guest_pass_uses_service_role on public.guest_pass_uses;
create policy guest_pass_uses_service_role on public.guest_pass_uses
  for all to service_role using (true) with check (true);

drop policy if exists policies_service_role on public.policies;
create policy policies_service_role on public.policies
  for all to service_role using (true) with check (true);

drop policy if exists admin_tasks_service_role on public.admin_tasks;
create policy admin_tasks_service_role on public.admin_tasks
  for all to service_role using (true) with check (true);

drop policy if exists admin_magic_links_service on public.admin_magic_links;
create policy admin_magic_links_service on public.admin_magic_links
  for all to service_role using (true) with check (true);

drop policy if exists sms_log_service on public.sms_log;
create policy sms_log_service on public.sms_log
  for all to service_role using (true) with check (true);

drop policy if exists drive_grants_service on public.google_drive_grants;
create policy drive_grants_service on public.google_drive_grants
  for all to service_role using (true) with check (true);

drop policy if exists drive_sync_log_service on public.drive_sync_log;
create policy drive_sync_log_service on public.drive_sync_log
  for all to service_role using (true) with check (true);

drop policy if exists drive_sync_queue_service on public.drive_sync_queue;
create policy drive_sync_queue_service on public.drive_sync_queue
  for all to service_role using (true) with check (true);

drop policy if exists payment_plans_service on public.payment_plans;
create policy payment_plans_service on public.payment_plans
  for all to service_role using (true) with check (true);

drop policy if exists installments_service on public.payment_plan_installments;
create policy installments_service on public.payment_plan_installments
  for all to service_role using (true) with check (true);

drop policy if exists email_templates_service on public.email_templates;
create policy email_templates_service on public.email_templates
  for all to service_role using (true) with check (true);

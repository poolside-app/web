-- =============================================================================
-- help_grounds — a member help topic for the Grounds Director (PLAN.md K3)
-- =============================================================================
-- Doug, 2026-10-04: members can report grounds, bathrooms and cleaning
-- (a missed mow, a bathroom out of supplies) straight to the Grounds
-- Director. Help topics now go to board positions, not to people picked in
-- settings.value.help_topics, which nothing reads any more.
-- =============================================================================

alter table public.help_requests drop constraint if exists help_requests_topic_check;
alter table public.help_requests add constraint help_requests_topic_check
  check (topic in ('keyfob', 'membership', 'parties', 'facility', 'grounds', 'other'));

update public.settings set value = value - 'help_topics' where value ? 'help_topics';

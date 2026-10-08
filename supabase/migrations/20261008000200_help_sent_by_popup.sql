-- Board replies to member help requests go by pop-up now, else email; never
-- by text (PLAN.md N5, Doug 2026-10-07). 'text' stays valid for replies
-- already sent that way.
alter table public.help_messages drop constraint if exists help_messages_sent_by_check;
alter table public.help_messages add constraint help_messages_sent_by_check
  check (sent_by is null or sent_by = any (array['popup', 'email', 'text']));

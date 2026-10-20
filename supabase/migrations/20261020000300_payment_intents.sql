-- PLAN.md BG3 (10/20 audit): keep the Stripe payment id on parties, fobs and
-- programs, so a refund or chargeback can be matched to what it bought
-- (_shared/payment_match.ts). Plan payments, signups and donations already
-- keep theirs.
alter table public.party_bookings add column if not exists stripe_payment_intent_id text;
alter table public.keyfobs add column if not exists stripe_payment_intent_id text;
alter table public.program_bookings add column if not exists stripe_payment_intent_id text;
create index if not exists party_bookings_pi on public.party_bookings (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists keyfobs_pi on public.keyfobs (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index if not exists program_bookings_pi on public.program_bookings (stripe_payment_intent_id) where stripe_payment_intent_id is not null;

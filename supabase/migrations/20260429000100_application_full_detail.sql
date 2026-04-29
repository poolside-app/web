-- =============================================================================
-- applications: full household + waivers + signatures (BE parity)
-- =============================================================================
-- Bishop Estates' v1 form captured a wizard's worth of data: every adult by
-- name (each with their own signature), every child by name + DOB,
-- five separate policy acceptances, plus a parent/guardian signature
-- standing in for all minors. Bringing those fields in so Poolside applies
-- one-and-done populate the household + every member on approve.
-- =============================================================================

alter table public.applications add column if not exists is_new_member   boolean default true;
alter table public.applications add column if not exists need_new_fob    boolean default false;
alter table public.applications add column if not exists prior_fob_number text;
alter table public.applications add column if not exists alt_email       text;

-- Adults: [{ name, email?, phone?, signature_url? }, ...] — index 0 is the primary
alter table public.applications add column if not exists adults_json     jsonb default '[]'::jsonb;
-- Children: [{ name, dob?, allergies? }, ...]
alter table public.applications add column if not exists children_json   jsonb default '[]'::jsonb;
-- Waiver acceptance: { rules: bool, guest: bool, party: bool, sitter: bool, waiver: bool }
alter table public.applications add column if not exists waivers_accepted jsonb default '{}'::jsonb;
alter table public.applications add column if not exists accepted_at     timestamptz;

-- Single primary applicant signature + a guardian signature standing in for all minors
alter table public.applications add column if not exists signature_primary  text;
alter table public.applications add column if not exists signature_guardian text;

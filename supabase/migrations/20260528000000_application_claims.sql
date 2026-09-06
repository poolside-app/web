-- =============================================================================
-- application claims — CSV-imported, member-claimable applications
-- =============================================================================
-- Reframes the CSV import: instead of creating active households/members, a
-- migrating club imports its existing roster as PRE-FILLED applications. Each
-- gets a one-time claim token; a blast email links the member to
-- apply.html?claim=<token>, where they see their info already filled in, edit
-- it, add family, accept the legal docs, and pay. On approval the existing
-- flow turns it into a real household — nothing downstream changes.
--
--   status 'prefilled'  → imported, not yet claimed (hidden from review queue)
--   status 'pending'    → member claimed + submitted (enters normal queue)
--
-- Also broadens payment_method so an admin can mark a migrated member paid by
-- the channel they actually used (cash / check) for people who already paid
-- the club under the old system.
-- =============================================================================

alter table public.applications
  add column if not exists claim_token_hash text,
  add column if not exists claim_source     text,    -- e.g. 'csv_import'
  add column if not exists import_run_id     uuid,    -- groups one CSV upload
  add column if not exists invited_at         timestamptz,
  add column if not exists claimed_at         timestamptz;

-- Claim-link lookups go through this (sha256 hex of the raw token).
create index if not exists applications_claim_token_idx
  on public.applications(claim_token_hash)
  where claim_token_hash is not null;

-- Powers the admin migration tracker (counts by status for imported rows).
create index if not exists applications_claim_source_idx
  on public.applications(tenant_id, claim_source, status)
  where claim_source is not null;

-- Allow the new 'prefilled' status. Drop + recreate (CHECK constraints can't
-- be altered in place).
alter table public.applications drop constraint if exists applications_status_chk;
alter table public.applications add constraint applications_status_chk
  check (status in ('prefilled','pending','approved','rejected'));

-- Broaden payment methods. 'stripe_plan' was already used in practice (the
-- cleanup cron + apply form reference it) but the old constraint only allowed
-- stripe/venmo; fold it in along with the manual channels.
alter table public.applications drop constraint if exists applications_payment_method_chk;
alter table public.applications add constraint applications_payment_method_chk
  check (payment_method is null or payment_method in
    ('stripe','stripe_plan','venmo','cash','check','manual'));

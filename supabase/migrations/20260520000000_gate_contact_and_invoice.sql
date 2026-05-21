-- =============================================================================
-- gate_panels: structured contact info + invoice tracking
-- =============================================================================
-- Until now we stuffed the tenant's contact info into the free-text `notes`
-- column and emailed Doug at request time. Doug's 2026-05-22 ask:
--
--   1. Collect a phone number (so Doug can actually call them — email-only
--      led to back-and-forth tag).
--   2. Stop auto-promising an invoice at request time. Doug wants to talk,
--      verify the integration is possible, ship + install the bridge,
--      THEN trigger the invoice from the provider admin once integration
--      is confirmed.
--
-- This migration adds:
--   - contact_{name,phone,email}: structured for table display + future
--     re-contacts; populated by the tenant request form.
--   - invoice_{amount_cents,sent_at,paid_at,note}: orthogonal to the
--     status lifecycle. Doug can send an invoice at any point in the
--     deployment flow (typically after integration is verified) without
--     regressing the status to 'invoiced'. The legacy 'invoiced' enum
--     value stays for backward compat — Doug can still set it manually.
-- =============================================================================

alter table public.gate_panels
  add column if not exists contact_name          text,
  add column if not exists contact_phone         text,
  add column if not exists contact_email         text,
  add column if not exists invoice_amount_cents  integer,
  add column if not exists invoice_sent_at       timestamptz,
  add column if not exists invoice_paid_at       timestamptz,
  add column if not exists invoice_note          text;

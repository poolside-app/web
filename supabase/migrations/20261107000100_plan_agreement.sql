-- PLAN.md CL2 (Doug 11/7: "If they have a payment plan, we should have another
-- signature that they accept the payment and payment plan agreements").
-- What a plan family signed at checkout: the agreement's lines as they read
-- them, the sentence they signed under, the signature (a PNG data URL), the
-- signer's name, when, and the terms version. The membership PDF prints it.
alter table public.applications add column if not exists plan_agreement jsonb;

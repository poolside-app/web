// =============================================================================
// email_template.ts — registry of system emails + render-and-send helper
// =============================================================================
// Single source of truth for every email Poolside sends. Each entry has:
//   key           — stable identifier used by code that fires the email
//   label         — admin-visible title in the Emails page list
//   description   — when this email fires
//   variables     — list of {{name}} placeholders the template can use
//   default_subject / default_body_html — what we ship as defaults
//
// Admin can override subject / body_html per tenant via the email_templates
// table. renderAndSend() looks up the override, falls back to the default,
// substitutes variables, and dispatches via sendEmail.
//
// Variable substitution: Mustache-like {{name}}. Values are HTML-escaped
// before insertion. The default templates can use {{vars}} freely without
// concern that user-controlled data (e.g. family_name) breaks layout.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail, escHtml, emailShell, type EmailAttachment } from './send_email.ts';

export type EmailTemplateDef = {
  key: string;
  label: string;
  description: string;
  audience: 'applicant' | 'member' | 'admin';
  variables: string[];
  default_subject: string;
  default_body_html: string;     // wrapped by emailShell at render time
};

// Helper to construct a default body wrapped in the standard shell.
// Templates only define their content; the shell adds the footer.
function withShell(content: string): string {
  // The shell needs tenant_name + club_url at render time. We expose them
  // as variables so the default content can reference them, then we wrap.
  // (When admin overrides, they can use the same {{vars}}.)
  return content;
}

export const EMAIL_REGISTRY: EmailTemplateDef[] = [
  // ─── Application lifecycle ────────────────────────────────────────────
  {
    key: 'application_received_venmo',
    label: 'Application received — Venmo path',
    description: 'Sent immediately when an applicant submits the apply form with Venmo selected as payment method.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'family_name', 'tier_label', 'tier_price', 'venmo_handle', 'num_adults', 'num_kids', 'club_url'],
    default_subject: 'We got your application — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">📋 We got your application</h2>
      <p style="margin:0 0 8px;color:#475569;line-height:1.55">Hi {{primary_name}} — thanks for applying to <b>{{tenant_name}}</b>. Your application is logged with the board.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#f7f3eb;border-radius:10px;font-size:13px;color:#475569;line-height:1.6">
        <div style="font-weight:700;color:#0a3b5c;margin-bottom:6px">What we received</div>
        <div><b>Family:</b> {{family_name}}</div>
        <div><b>Primary:</b> {{primary_name}}</div>
        <div><b>Tier:</b> {{tier_label}} ({{tier_price}})</div>
        <div><b>Adults:</b> {{num_adults}} · <b>Children:</b> {{num_kids}}</div>
      </div>
      <h3 style="font-family:Georgia,serif;color:#0a3b5c;margin:24px 0 8px;font-size:16px">Next step: send your Venmo payment</h3>
      <p style="margin:0 0 12px">Send your annual dues to <b>@{{venmo_handle}}</b> ({{tier_price}} for the {{tier_label}} tier). Once the board verifies your payment, you'll receive a separate email with your member sign-in link.</p>
      <p style="margin:0;color:#64748b;font-size:13px">Tip: include the family name in your Venmo memo so we can match it quickly.</p>
      <div style="margin:24px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — it includes the full text of every policy you accepted plus your signature. Please keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Questions? Just reply to this email.</p>
    `),
  },
  // The Stripe-path "application received" templates were removed —
  // payment + welcome are bundled into one email now (see
  // application_approved_stripe_paid / application_approved_plan_first
  // below). The submit handler skips a "received" send for Stripe paths
  // entirely, so unpaid carts get cleaned up automatically by cron rather
  // than producing a confusing duplicate email.
  {
    key: 'application_received_other',
    label: 'Application received — payment TBD',
    description: 'Sent on submit when no payment method was selected (decide-later flow).',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'family_name', 'tier_label', 'tier_price', 'num_adults', 'num_kids', 'club_url'],
    default_subject: 'We got your application — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">📋 We got your application</h2>
      <p style="margin:0 0 8px;color:#475569;line-height:1.55">Hi {{primary_name}} — thanks for applying to <b>{{tenant_name}}</b>. Your application is logged with the board.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#f7f3eb;border-radius:10px;font-size:13px;color:#475569;line-height:1.6">
        <div><b>Family:</b> {{family_name}}</div>
        <div><b>Tier:</b> {{tier_label}} ({{tier_price}})</div>
        <div><b>Adults:</b> {{num_adults}} · <b>Children:</b> {{num_kids}}</div>
      </div>
      <p style="margin:0 0 12px">A board member will reach out within a few days with payment options. Once payment is sorted, you'll receive a separate email with your member sign-in link.</p>
      <div style="margin:24px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — it includes the full text of every policy you accepted plus your signature. Please keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Questions? Just reply to this email.</p>
    `),
  },
  {
    key: 'application_approved_stripe_paid',
    label: 'Welcome — Stripe paid (combined receipt + welcome)',
    description: 'Sent when an applicant pays via Stripe — single email confirms application received AND payment cleared. The "application received" email is suppressed for Stripe paths so the applicant gets exactly one email for the whole flow. Legal-evidence PDF is attached.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'club_url'],
    default_subject: 'You\'re in — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — we got your application <b>and</b> your card payment cleared. Your membership is active. One email, all set.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
      <div style="margin:18px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — it includes the verbatim text of every policy you accepted plus your signature. Please keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Sign-in link is good for one use and expires in 7 days. If it expires, request a fresh one at <a href="{{club_url}}/m/login.html">your member login page</a>.</p>
    `),
  },
  {
    key: 'application_approved_venmo_verified',
    label: 'Welcome — Venmo verified at approval',
    description: 'Sent when admin approves AND verifies Venmo payment in the same step (rare path).',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'club_url'],
    default_subject: 'Payment verified — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Payment verified — welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 16px;color:#64748b;line-height:1.55">Hi {{primary_name}} — your Venmo payment was verified by the board. Your dues are paid in full and you're all set.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
      <p style="margin:0;color:#94a3b8;font-size:12px">Sign-in link is good for one use and expires in 7 days.</p>
    `),
  },
  {
    key: 'application_approved_unpaid_venmo',
    label: 'Approved — final step is Venmo payment',
    description: 'Sent when admin approves but Venmo payment hasn\'t been verified yet. Prompts the member to send their dues.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'venmo_handle', 'club_url'],
    default_subject: 'You\'re approved — final step is dues — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 You're approved!</h2>
      <p style="margin:0 0 16px;color:#64748b;line-height:1.55">Hi {{primary_name}} — your application was approved. One last thing: please send your annual dues via Venmo so we can finalize your membership.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
      <h3 style="font-family:Georgia,serif;color:#0a3b5c;margin:24px 0 6px;font-size:16px">Final step: send Venmo</h3>
      <p style="margin:0 0 8px;color:#64748b">Send your annual dues to <b>@{{venmo_handle}}</b>. We'll send another email confirming once the payment is verified.</p>
      <p style="margin:0;color:#94a3b8;font-size:12px">Sign-in link is good for one use and expires in 7 days.</p>
    `),
  },
  {
    key: 'application_approved_plan_first',
    label: 'Welcome — first installment paid (combined receipt + welcome)',
    description: 'Sent when an applicant\'s first Stripe-plan installment clears. Single email confirms application received AND first installment paid AND second installment scheduled. The "application received" email is suppressed for plan paths. Legal-evidence PDF attached.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'club_url'],
    default_subject: 'You\'re in — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — we got your application <b>and</b> your first installment cleared. Your membership is active. Your second installment will auto-charge on the final due date and we'll email a reminder before then.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
      <div style="margin:18px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — it includes the verbatim text of every policy you accepted plus your signature. Please keep it for your records.
      </div>
    `),
  },
  {
    key: 'application_approved_other',
    label: 'Approved — payment TBD',
    description: 'Generic approval email when no specific payment branch matches (e.g. decide-later, edge cases).',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'club_url'],
    default_subject: 'Welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 16px;color:#64748b;line-height:1.55">Hi {{primary_name}} — your application was approved. Click below to sign in to your member dashboard.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">A board member will reach out shortly with payment details.</p>
    `),
  },
  // ── "Guest checkout" no-app member variants (Doug 2026-05-23) ─────────
  // Sent to applicants who picked "Just sign me up" on the apply form.
  // Short + warm copy with no magic-link CTA. One subtle "you can opt in
  // later" line at the bottom for the day they change their mind. Same
  // templating system — admins can customize each one in the Emails admin.
  {
    key: 'application_approved_stripe_paid_no_app',
    label: 'Welcome (no app) — Stripe paid',
    description: 'Sent to guest-checkout applicants whose Stripe payment cleared. No magic-link CTA — they opted out of the app.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'club_url'],
    default_subject: 'Welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — we got your application and your payment cleared. Your family's on the roster. See you at the pool!</p>
      <div style="margin:18px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.5">Want to manage your membership online? Sign in any time at <a href="{{club_url}}/m/" style="color:#94a3b8">{{club_url}}/m/</a> — your email or phone is your password, no setup needed.</p>
    `),
  },
  {
    key: 'application_approved_venmo_verified_no_app',
    label: 'Welcome (no app) — Venmo verified at approval',
    description: 'Sent to guest-checkout applicants when admin approves + verifies Venmo in one shot.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'club_url'],
    default_subject: 'Payment verified — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Payment verified — welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — your Venmo payment was verified by the board. Dues are paid in full and your family's on the roster. See you at the pool!</p>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.5">Changed your mind about the app? You can sign in any time at <a href="{{club_url}}/m/" style="color:#94a3b8">{{club_url}}/m/</a> — your email or phone is your password, no setup needed.</p>
    `),
  },
  {
    key: 'application_approved_unpaid_venmo_no_app',
    label: 'Approved (no app) — final step is Venmo payment',
    description: 'Sent to guest-checkout applicants who are approved but haven\'t Venmo\'d their dues yet.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'venmo_handle', 'club_url'],
    default_subject: 'You\'re approved — final step is dues — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 You're approved!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — your application was approved. One last thing: please send your annual dues via Venmo so we can finalize your membership.</p>
      <h3 style="font-family:Georgia,serif;color:#0a3b5c;margin:18px 0 6px;font-size:16px">Send Venmo</h3>
      <p style="margin:0 0 12px;color:#475569">Send your annual dues to <b>@{{venmo_handle}}</b>. The board will email another confirmation once the payment lands.</p>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.5">You can manage your membership online any time at <a href="{{club_url}}/m/" style="color:#94a3b8">{{club_url}}/m/</a> — your email or phone is your password, no setup needed.</p>
    `),
  },
  {
    key: 'application_approved_plan_first_no_app',
    label: 'Welcome (no app) — first installment paid',
    description: 'Sent to guest-checkout applicants whose first Stripe-plan installment cleared.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'club_url'],
    default_subject: 'You\'re in — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — we got your application and your first installment cleared. Your membership is active and your family's on the roster. Your second installment will auto-charge on the final due date.</p>
      <div style="margin:18px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.5">Want to manage your membership online? Sign in any time at <a href="{{club_url}}/m/" style="color:#94a3b8">{{club_url}}/m/</a> — your email or phone is your password, no setup needed.</p>
    `),
  },
  {
    key: 'application_approved_other_no_app',
    label: 'Approved (no app) — payment TBD',
    description: 'Generic approval email for guest-checkout applicants when no specific payment branch matches.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'club_url'],
    default_subject: 'Welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — your application was approved. Your family's on the roster.</p>
      <p style="margin:0 0 12px;color:#64748b;font-size:13px">A board member will reach out shortly with payment details.</p>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px;line-height:1.5">Want to manage your membership online? Sign in any time at <a href="{{club_url}}/m/" style="color:#94a3b8">{{club_url}}/m/</a> — your email or phone is your password, no setup needed.</p>
    `),
  },
  {
    key: 'application_rejected',
    label: 'Application rejected',
    description: 'Sent when admin rejects an application. Optional admin notes appear as the reason.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'admin_notes', 'club_url'],
    default_subject: 'Update on your {{tenant_name}} application',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Update on your application</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — after review, the board wasn't able to approve your application to <b>{{tenant_name}}</b> at this time.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#f7f3eb;border-radius:10px;font-size:13px;color:#475569;line-height:1.6"><b style="color:#0a3b5c">Note from the board:</b><br>{{admin_notes}}</div>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px">If you have questions or would like to discuss, please reply to this email.</p>
    `),
  },
  {
    key: 'payment_verified_venmo',
    label: 'Venmo payment verified',
    description: 'Sent when admin clicks "Verify Venmo Payment" after the application is already approved.',
    audience: 'member',
    variables: ['tenant_name', 'primary_name', 'club_url'],
    default_subject: 'Payment verified — you\'re paid in full at {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Payment verified!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — the board verified your Venmo payment to <b>{{tenant_name}}</b>. Your dues are paid in full and your membership is active for the season.</p>
      <p style="margin:24px 0">
        <a href="{{club_url}}/m/login.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to your member home</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">If you saved your sign-in link from the welcome email, that still works too.</p>
    `),
  },
  // ─── Payment plan installment lifecycle ──────────────────────────────
  {
    key: 'plan_installment_paid_partial',
    label: 'Installment cleared (more to go)',
    description: 'Sent when a payment plan installment charges successfully and there are more installments remaining.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'amount', 'sequence', 'next_amount', 'next_due_date', 'club_url'],
    default_subject: 'Installment {{sequence}} paid — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Installment {{sequence}} cleared</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — we charged <b>{{amount}}</b> on the card you saved at sign-up.</p>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Your next installment of <b>{{next_amount}}</b> auto-charges on <b>{{next_due_date}}</b>. We'll send a reminder a few weeks before.</p>
      <p style="margin:24px 0">
        <a href="{{club_url}}/m/login.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to your member home</a>
      </p>
    `),
  },
  {
    key: 'plan_installment_paid_final',
    label: 'Installment cleared (paid in full)',
    description: 'Sent when the final payment plan installment charges successfully — member is paid in full.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'amount', 'club_url'],
    default_subject: 'Final installment paid — you\'re paid in full at {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ You're paid in full!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — we charged your final installment of <b>{{amount}}</b>. Your dues are paid in full for the season. Thanks for being part of <b>{{tenant_name}}</b>!</p>
      <p style="margin:24px 0">
        <a href="{{club_url}}/m/login.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to your member home</a>
      </p>
    `),
  },
  // ─── Household roster ────────────────────────────────────────────────
  {
    key: 'household_member_added',
    label: 'Household member added',
    description: 'Sent to the household primary when they add another family member from the member home page. Attaches the legal-evidence PDF (accepted policies + signature).',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'primary_name', 'member_name', 'member_role', 'club_url'],
    default_subject: 'New household member added — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Household updated</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — you added <b>{{member_name}}</b> ({{member_role}}) to the {{family_name}} household at <b>{{tenant_name}}</b>.</p>
      <div style="margin:24px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy is attached</b> — it includes the verbatim text of every policy {{member_name}} (or you, as guardian) accepted plus the signature on file. Please keep it for your records.
      </div>
      <p style="margin:24px 0">
        <a href="{{club_url}}/m" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Open my member home</a>
      </p>
      <p style="margin:0;color:#94a3b8;font-size:12px">If you didn't make this change, please reply to this email so the board can investigate.</p>
    `),
  },
  {
    key: 'plan_installment_failed',
    label: 'Installment failed (card declined)',
    description: 'Sent when an installment first fails to charge. Subsequent retries stay silent. Final lapse alerts the admin separately.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'amount', 'sequence', 'club_url'],
    default_subject: '[Action needed] Card declined — {{tenant_name}} installment {{sequence}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 8px">⚠ Card declined</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — we tried to charge <b>{{amount}}</b> for installment {{sequence}} of your <b>{{tenant_name}}</b> dues, but your card was declined.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#fef3c7;border-radius:10px;font-size:13px;color:#7c2d12">
        <b>What happens next:</b> we'll retry automatically over the next ~14 days. To avoid lapsing, please contact the board to update your payment method.
      </div>
      <p style="margin:24px 0">
        <a href="{{club_url}}/m/login.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to contact the board</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">Common reasons: card expired, address changed, or daily limit reached. Replying to this email is the fastest way to reach us.</p>
    `),
  },

  // ─── Auto-renew ───────────────────────────────────────────────────────
  {
    key: 'auto_renew_notice',
    label: 'Auto-renew — heads up before we charge',
    description: 'Sent when the new season opens to households with auto-renew on, a set number of days BEFORE their card is charged. The whole point is that nobody is charged by surprise, so this fires before any money moves.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'amount', 'season', 'charge_date', 'manage_url', 'club_url'],
    default_subject: 'Heads up — renewing your {{tenant_name}} membership on {{charge_date}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🏊 Your {{season}} season is coming up</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — you asked us to renew your <b>{{tenant_name}}</b> membership automatically, so this is your heads up before anything happens.</p>
      <div style="margin:18px 0;padding:16px 18px;background:#f7f3eb;border-radius:10px;color:#0a3b5c">
        <div style="font-size:26px;font-family:Georgia,serif;font-weight:600;line-height:1">{{amount}}</div>
        <div style="font-size:13px;color:#475569;margin-top:6px">will be charged to your saved card on <b>{{charge_date}}</b> for the {{season}} season.</div>
      </div>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">You don't need to do anything — we'll take care of it and email you a receipt.</p>
      <p style="margin:24px 0">
        <a href="{{manage_url}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Review or turn off auto-renew</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">Changed your mind, or need to update the card? Use the button above before {{charge_date}} and nothing will be charged.</p>
    `),
  },
  {
    key: 'auto_renew_charged',
    label: 'Auto-renew — receipt',
    description: 'Sent immediately after a successful auto-renew charge. Confirms the season is paid so the member never has to wonder whether it went through.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'amount', 'season', 'club_url'],
    default_subject: "You're all set for {{season}} — {{tenant_name}}",
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#166534;margin:0 0 8px">✅ You're renewed for {{season}}</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — we charged <b>{{amount}}</b> to your saved card and your <b>{{tenant_name}}</b> membership is paid through the {{season}} season. Nothing else to do.</p>
      <p style="margin:24px 0">
        <a href="{{club_url}}/m/" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Open my club</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">Keep this email as your receipt. See you at the pool.</p>
    `),
  },
  {
    key: 'auto_renew_failed',
    label: 'Auto-renew — card declined',
    description: 'Sent when an auto-renew charge is declined. The renewal stays open so the member can finish it themselves rather than losing their spot.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'amount', 'season', 'manage_url', 'club_url'],
    default_subject: '[Action needed] We couldn\'t renew your {{tenant_name}} membership',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 8px">⚠ Your card was declined</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — we tried to renew your <b>{{tenant_name}}</b> membership for {{season}} ({{amount}}) using your saved card, and it didn't go through.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#fef3c7;border-radius:10px;font-size:13px;color:#7c2d12;line-height:1.6">
        <b>Your spot is still held.</b> Nothing has been cancelled — we've left your renewal open so you can finish it with a different card whenever suits you.
      </div>
      <p style="margin:24px 0">
        <a href="{{manage_url}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Finish renewing</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">Usually this is an expired card or a new billing address. Replying to this email reaches the board directly.</p>
    `),
  },

  {
    key: 'renewal_invite',
    label: 'Renewal invite (no login needed)',
    description: 'Sent when the board sends renewal links. Contains a one-time link that opens a pre-filled renewal the member can pay without signing in — the path for households that never use the app.',
    audience: 'member',
    variables: ['tenant_name', 'family_name', 'season', 'renew_link', 'club_url'],
    default_subject: 'Time to renew your {{tenant_name}} membership for {{season}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🏊 Renew for {{season}}</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{family_name}} — it's time to renew your <b>{{tenant_name}}</b> membership for the {{season}} season.</p>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Everything is already filled in. Tap below, check it over, and pay — <b>no password, no app, no signing in</b>.</p>
      <p style="margin:24px 0">
        <a href="{{renew_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:14px 26px;border-radius:10px;font-weight:600;display:inline-block;font-size:16px">Renew my membership</a>
      </p>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px">You can pay in full, or split it into smaller payments if your club offers that.</p>
      <p style="margin:0;color:#64748b;font-size:13px">This link is just for your household — please don't forward it. Replying to this email reaches the board.</p>
    `),
  },

  // ─── Party booking lifecycle ──────────────────────────────────────────
  {
    key: 'party_request_received',
    label: 'Party request received',
    description: 'Sent when a member submits a party booking request. The board still needs to approve.',
    audience: 'member',
    variables: ['tenant_name', 'primary_name', 'party_title', 'party_date', 'party_time', 'club_url'],
    default_subject: 'Party request received — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Got your party request</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — thanks for booking <b>{{party_title}}</b> for <b>{{party_date}}</b> at {{party_time}}. The board will review and get back to you shortly.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#f7f3eb;border-radius:10px;font-size:13px;color:#475569;line-height:1.55">
        <b>What happens next:</b> a board member will approve or reject your request. If approved, you'll get a follow-up email with payment instructions. The party is officially on the calendar only after payment is received.
      </div>
      <p style="margin:0;color:#94a3b8;font-size:12px">Hosting at <a href="{{club_url}}" style="color:#0a3b5c">{{tenant_name}}</a></p>
    `),
  },
  {
    key: 'party_approved_pay',
    label: 'Party approved — payment needed',
    description: 'Sent when the board approves a party request. The member completes payment to officially book the date.',
    audience: 'member',
    variables: ['tenant_name', 'primary_name', 'party_title', 'party_date', 'party_time', 'price', 'venmo_handle', 'club_url', 'member_url'],
    default_subject: 'Your party is approved — pay to confirm',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Party approved — last step is payment</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — the board approved <b>{{party_title}}</b> for <b>{{party_date}}</b> at {{party_time}}. To officially lock in the date, please complete the {{price}} party fee.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#f7f3eb;border-radius:10px;font-size:13px;color:#475569;line-height:1.6">
        <div style="font-weight:700;color:#0a3b5c;margin-bottom:6px">How to pay</div>
        <div><b>Venmo:</b> send {{price}} to <b>@{{venmo_handle}}</b>, then sign in and tap "I paid" so the treasurer can verify.</div>
        <div style="margin-top:6px"><b>Card / Stripe:</b> sign in below and click "Pay with card" — the date locks instantly when payment clears (small processing fee added).</div>
      </div>
      <p style="margin:18px 0">
        <a href="{{member_url}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to pay →</a>
      </p>
      <p style="margin:0;color:#94a3b8;font-size:12px">Until payment is received the date is held but not officially booked. If another member pays for the same day first, you'd need to pick a different date.</p>
    `),
  },
  {
    key: 'party_confirmed',
    label: 'Party officially booked',
    description: 'Sent when payment is verified (Venmo) or auto-confirmed (Stripe). Party is now on the calendar.',
    audience: 'member',
    variables: ['tenant_name', 'primary_name', 'party_title', 'party_date', 'party_time', 'club_url'],
    default_subject: '🎉 Your party is officially booked',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">🎉 Officially booked!</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — payment received. <b>{{party_title}}</b> is locked in for <b>{{party_date}}</b> at {{party_time}}.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#dcfce7;border-radius:10px;font-size:13px;color:#14532d;line-height:1.55">
        Your party is now on the {{tenant_name}} calendar — visible to members so everyone knows the pool's reserved that day.
      </div>
      <p style="margin:18px 0">
        <a href="{{club_url}}/m/index.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Open member home →</a>
      </p>
      <p style="margin:0;color:#64748b;font-size:13px">If anything changes, reply to this email or message the board directly.</p>
    `),
  },
  {
    key: 'party_rejected',
    label: 'Party request not approved',
    description: 'Sent when the board rejects a party request (date conflict, capacity, policy issue, etc.).',
    audience: 'member',
    variables: ['tenant_name', 'primary_name', 'party_title', 'party_date', 'admin_notes', 'club_url'],
    default_subject: 'Update on your party request — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 8px">Party request not approved</h2>
      <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi {{primary_name}} — unfortunately we can't approve <b>{{party_title}}</b> for {{party_date}}.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#fef3c7;border-radius:10px;font-size:13px;color:#7c2d12;line-height:1.55">
        <b>Note from the board:</b> {{admin_notes}}
      </div>
      <p style="margin:0;color:#475569;line-height:1.55">Pick a different date and submit a new request — sign in at <a href="{{club_url}}/m/login.html" style="color:#0a3b5c">{{club_url}}</a>.</p>
    `),
  },
];

// Lookup helper
const REGISTRY_MAP: Record<string, EmailTemplateDef> = (() => {
  const m: Record<string, EmailTemplateDef> = {};
  for (const t of EMAIL_REGISTRY) m[t.key] = t;
  return m;
})();

export function getRegistryEntry(key: string): EmailTemplateDef | null {
  return REGISTRY_MAP[key] ?? null;
}

// Substitute {{var}} in a string with HTML-escaped values from `vars`. Missing
// vars become empty strings (template authors should write fallbacks if they
// expect blank values to look weird).
export function substitute(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => {
    const v = vars[name];
    return v == null ? '' : escHtml(String(v));
  });
}

// Look up tenant override (if any) for the given key.
async function loadOverride(sb: SupabaseClient, tenantId: string, key: string): Promise<{ subject: string; body_html: string; enabled: boolean } | null> {
  const { data } = await sb.from('email_templates')
    .select('subject, body_html, enabled')
    .eq('tenant_id', tenantId).eq('key', key).maybeSingle();
  return (data as { subject: string; body_html: string; enabled: boolean } | null) ?? null;
}

// Render a template (custom override or default), substituting variables, and
// send via Resend. Returns { sent, error?, suppressed? }. Best-effort: never
// throws — caller can ignore the result.
export async function renderAndSend(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    templateKey: string;
    to: string;
    variables: Record<string, string | number | null | undefined>;
    replyTo?: string;
    attachments?: EmailAttachment[];
  },
): Promise<{ sent: boolean; error?: string; suppressed?: boolean }> {
  const def = getRegistryEntry(args.templateKey);
  if (!def) return { sent: false, error: `unknown template key: ${args.templateKey}` };
  if (!args.to) return { sent: false, error: 'no recipient' };

  let subject = def.default_subject;
  let bodyContent = def.default_body_html;
  try {
    const ovr = await loadOverride(sb, args.tenantId, args.templateKey);
    if (ovr) {
      if (!ovr.enabled) return { sent: false, suppressed: true };
      subject = ovr.subject || def.default_subject;
      bodyContent = ovr.body_html || def.default_body_html;
    }
  } catch { /* fall through to defaults */ }

  // Make sure tenant_name and club_url are always available, even if caller
  // forgot to pass them — pull from the tenants row as a backstop.
  let vars = { ...args.variables };
  if (!vars.tenant_name || !vars.club_url) {
    try {
      const { data: tenant } = await sb.from('tenants').select('display_name, slug').eq('id', args.tenantId).maybeSingle();
      if (tenant) {
        if (!vars.tenant_name) vars.tenant_name = tenant.display_name as string;
        if (!vars.club_url)    vars.club_url    = `https://${tenant.slug as string}.poolsideapp.com`;
      }
    } catch { /* keep what we have */ }
  }

  const renderedSubject = substitute(subject, vars);
  const renderedContent = substitute(bodyContent, vars);
  const html = emailShell({
    tenantName: String(vars.tenant_name ?? ''),
    clubUrl:    String(vars.club_url ?? ''),
    contentHtml: renderedContent,
  });

  return await sendEmail({
    to: args.to,
    subject: renderedSubject,
    html,
    replyTo: args.replyTo,
    attachments: args.attachments,
  });
}

// Render-only, used by the admin Preview pane. Returns the rendered html so
// the UI can show a live preview when the admin edits the body.
export function renderPreview(
  templateKey: string,
  customSubject: string | null,
  customBodyHtml: string | null,
  vars: Record<string, string | number | null | undefined>,
): { subject: string; html: string } {
  const def = getRegistryEntry(templateKey);
  if (!def) return { subject: '(unknown template)', html: '' };
  const subj = customSubject ?? def.default_subject;
  const body = customBodyHtml ?? def.default_body_html;
  const renderedSubject = substitute(subj, vars);
  const renderedContent = substitute(body, vars);
  const html = emailShell({
    tenantName: String(vars.tenant_name ?? 'Sample Club'),
    clubUrl:    String(vars.club_url ?? 'https://example.poolsideapp.com'),
    contentHtml: renderedContent,
  });
  return { subject: renderedSubject, html };
}

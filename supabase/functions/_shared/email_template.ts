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
  {
    key: 'application_received_stripe',
    label: 'Application received — Stripe single payment',
    description: 'Sent on submit when applicant chose Stripe full-pay. Note: by the time this arrives, the applicant should be in Stripe checkout.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'family_name', 'tier_label', 'tier_price', 'num_adults', 'num_kids', 'club_url'],
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
      <h3 style="font-family:Georgia,serif;color:#0a3b5c;margin:24px 0 8px;font-size:16px">Next step: complete your card payment</h3>
      <p style="margin:0 0 12px">If you didn't already complete Stripe checkout, return to your application tab and click <b>Pay with card</b>. The moment your payment goes through, your membership is approved automatically and we'll email you a sign-in link.</p>
      <div style="margin:24px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — it includes the full text of every policy you accepted plus your signature. Please keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Questions? Just reply to this email.</p>
    `),
  },
  {
    key: 'application_received_stripe_plan',
    label: 'Application received — Stripe payment plan',
    description: 'Sent on submit when applicant chose 2-installment Stripe payment plan.',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'family_name', 'tier_label', 'tier_price', 'first_amount', 'second_amount', 'final_due_date', 'num_adults', 'num_kids', 'club_url'],
    default_subject: 'We got your application — {{tenant_name}}',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">📋 We got your application</h2>
      <p style="margin:0 0 8px;color:#475569;line-height:1.55">Hi {{primary_name}} — thanks for applying to <b>{{tenant_name}}</b>. Your application is logged with the board.</p>
      <div style="margin:18px 0;padding:14px 16px;background:#f7f3eb;border-radius:10px;font-size:13px;color:#475569;line-height:1.6">
        <div style="font-weight:700;color:#0a3b5c;margin-bottom:6px">What we received</div>
        <div><b>Family:</b> {{family_name}}</div>
        <div><b>Tier:</b> {{tier_label}} ({{tier_price}})</div>
        <div><b>Adults:</b> {{num_adults}} · <b>Children:</b> {{num_kids}}</div>
      </div>
      <h3 style="font-family:Georgia,serif;color:#0a3b5c;margin:24px 0 8px;font-size:16px">Next step: complete your first installment</h3>
      <p style="margin:0 0 12px">If you didn't already complete Stripe checkout, return to your application tab and click <b>Start payment plan</b>. We'll charge <b>{{first_amount}}</b> now and auto-charge <b>{{second_amount}}</b> on <b>{{final_due_date}}</b>. Your membership activates as soon as the first payment goes through.</p>
      <div style="margin:24px 0 0;padding:12px 14px;background:#eef2f7;border-radius:8px;font-size:13px;color:#475569;line-height:1.5">
        <b style="color:#0a3b5c">📎 A signed copy of your application is attached</b> — it includes the full text of every policy you accepted plus your signature. Please keep it for your records.
      </div>
      <p style="margin:18px 0 0;color:#94a3b8;font-size:12px">Questions? Just reply to this email.</p>
    `),
  },
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
    label: 'Welcome — Stripe paid',
    description: 'Sent when an application is approved AND the member already paid via Stripe (auto-approve via webhook).',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'club_url'],
    default_subject: 'Payment confirmed — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ Payment confirmed — welcome to {{tenant_name}}!</h2>
      <p style="margin:0 0 16px;color:#64748b;line-height:1.55">Hi {{primary_name}} — your card payment cleared and your membership is active. Sign in below to see your member home.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
      <p style="margin:0;color:#94a3b8;font-size:12px">Sign-in link is good for one use and expires in 7 days. If it expires, ask for a fresh one at <a href="{{club_url}}/m/login.html">your member login page</a>.</p>
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
    label: 'Welcome — first installment paid',
    description: 'Sent when an applicant\'s first Stripe-plan installment clears (auto-approve).',
    audience: 'applicant',
    variables: ['tenant_name', 'primary_name', 'sign_in_link', 'club_url'],
    default_subject: 'First installment paid — welcome to {{tenant_name}}!',
    default_body_html: withShell(`
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">✓ First installment paid — you're in!</h2>
      <p style="margin:0 0 16px;color:#64748b;line-height:1.55">Hi {{primary_name}} — your first installment cleared and your membership is active. Your second installment will auto-charge on the final due date and we'll email a reminder before each charge.</p>
      <p style="margin:24px 0">
        <a href="{{sign_in_link}}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in to {{tenant_name}}</a>
      </p>
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

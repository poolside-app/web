// =============================================================================
// email_template.ts — the emails Poolside sends, and the one way to send them
// =============================================================================
// PLAN.md T (Doug, 2026-10-08: "the emails tab is super confusing"). There
// are 15 emails, grouped by the moment they go out. Each has two parts:
//
//   - The message: plain words a club can change on Settings → Emails
//     (stored per club in the email_templates table: subject, body_html
//     holds the message, enabled). {{placeholders}} are filled in, escaped.
//   - Poolside's part: the heading, the details box, the button, the
//     sign-in line, built here from the same variables. A club can't break it.
//
// The code that sends an email is unchanged. It still names the exact
// version ('application_approved_stripe_paid_no_app' and so on); ALIASES map
// those to the merged email plus what differs (how they paid, app or not),
// which only changes Poolside's part. 12 welcome versions became 1 email.
//
// 'application_received_stripe' and '_stripe_plan' are deliberately unknown:
// a family paying by card gets the Welcome email as soon as it clears, not a
// "we got it" first.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendEmail, escHtml, emailShell, type EmailAttachment } from './send_email.ts';

type Vars = Record<string, string | number | null | undefined>;
type Variant = Record<string, unknown>;

export type EmailSection = 'signup' | 'welcome' | 'payments' | 'renewals' | 'parties' | 'family';
export const EMAIL_SECTIONS: Array<{ id: EmailSection; label: string }> = [
  { id: 'signup', label: 'Signing up' },
  { id: 'welcome', label: 'Welcome' },
  { id: 'payments', label: 'Payments' },
  { id: 'renewals', label: 'Renewals' },
  { id: 'parties', label: 'Parties' },
  { id: 'family', label: 'Family changes' },
];

export type EmailDef = {
  key: string;
  label: string;
  /** When it goes out, in plain words. */
  when: string;
  section: EmailSection;
  default_subject: string;
  /** The part a club can change: short paragraphs, {{placeholders}}. */
  default_message: string;
  /** Placeholders worth offering in the editor. */
  placeholders: string[];
  /** What Poolside adds under the message, said plainly for the editor. */
  adds: string;
  heading: (v: Vars, x: Variant) => string;
  details?: (v: Vars, x: Variant) => string;
  /** Versions to preview, for the merged emails. */
  variants?: Array<{ id: string; label: string; x: Variant }>;
};

// ── Building blocks for Poolside's part ─────────────────────────────────────
const e = (v: unknown) => escHtml(v == null ? '' : String(v));
const para = (html: string) => `<p style="margin:0 0 12px;color:#334155;line-height:1.6">${html}</p>`;
const small = (html: string) => `<p style="margin:12px 0 0;color:#64748b;font-size:13px;line-height:1.5">${html}</p>`;
const ok = (html: string) => `<p style="margin:16px 0;padding:12px 14px;background:#f0fdf4;border-radius:10px;color:#166534;line-height:1.55">${html}</p>`;
const box = (html: string, tone: 'plain' | 'warn' = 'plain') =>
  `<div style="margin:16px 0;padding:14px 16px;background:${tone === 'warn' ? '#fef3c7' : '#f7f3eb'};border-radius:10px;font-size:14px;color:${tone === 'warn' ? '#7c2d12' : '#334155'};line-height:1.6">${html}</div>`;
const button = (label: string, url: unknown) => url
  ? `<p style="margin:22px 0"><a href="${e(url)}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">${e(label)}</a></p>`
  : '';
const link = (url: unknown, text?: string) => `<a href="${e(url)}" style="color:#0a3b5c">${e(text ?? url)}</a>`;
const signedCopy = (x: Variant, who = 'every policy you accepted') => x.attached
  ? small(`📎 A signed copy of your application is attached, with ${who} and your signature. Please keep it for your records.`) : '';
const boardNote = (v: Vars) => v.admin_notes ? box(`<b>Note from the board:</b> ${e(v.admin_notes)}`, 'warn') : '';
const memberHome = (v: Vars) => `${String(v.club_url ?? '')}/m/`;

export const EMAIL_REGISTRY: EmailDef[] = [
  // ─── Signing up ────────────────────────────────────────────────────────
  {
    key: 'application_received', section: 'signup',
    label: 'Application received',
    when: 'Right after a family sends the signup form, when they\'re paying by Venmo or later. A family paying by card gets the Welcome email instead, as soon as they\'ve paid.',
    default_subject: 'We got your application to {{tenant_name}}',
    default_message: '<p>Hi {{primary_name}},</p><p>Thanks for applying to {{tenant_name}}! The board has your application.</p><p>Questions? Just reply to this email.</p>',
    placeholders: ['primary_name', 'family_name', 'tenant_name'],
    adds: 'what they signed up for, how to pay, and a copy of their signed application',
    heading: () => '📋 We got your application',
    details: (v, x) => box(`<b>Family:</b> ${e(v.family_name)}<br><b>Membership:</b> ${e(v.tier_label)}${v.tier_price ? ` (${e(v.tier_price)})` : ''}<br><b>Adults:</b> ${e(v.num_adults)} · <b>Children:</b> ${e(v.num_kids)}`)
      + (x.pay === 'venmo'
        ? box(`<b>Next step: send your dues by Venmo</b><br>Send ${e(v.tier_price)} to <b>@${e(v.venmo_handle)}</b>, with your family name in the note. Once the board sees it, you'll get an email with your sign-in link.`, 'warn')
        : para('A board member will be in touch about payment. Once that\'s sorted, you\'ll get an email with your sign-in link.'))
      + signedCopy(x),
    variants: [
      { id: 'venmo', label: 'Paying by Venmo', x: { pay: 'venmo', attached: true } },
      { id: 'other', label: 'Paying later', x: { pay: 'other', attached: true } },
    ],
  },
  {
    key: 'application_rejected', section: 'signup',
    label: 'Application not approved',
    when: 'When the board turns down an application.',
    default_subject: 'Update on your {{tenant_name}} application',
    default_message: '<p>Hi {{primary_name}},</p><p>After review, the board wasn\'t able to approve your application to {{tenant_name}} at this time.</p><p>If you have questions, just reply to this email.</p>',
    placeholders: ['primary_name', 'tenant_name'],
    adds: 'the board\'s note, if you wrote one',
    heading: () => 'Update on your application',
    details: v => boardNote(v),
  },

  // ─── Welcome ───────────────────────────────────────────────────────────
  {
    key: 'welcome', section: 'welcome',
    label: 'Welcome email',
    when: 'When a new family is approved, or as soon as their card payment clears.',
    default_subject: 'Welcome to {{tenant_name}}!',
    default_message: '<p>Hi {{primary_name}},</p><p>Welcome to {{tenant_name}}! We can\'t wait to see you at the pool.</p>',
    placeholders: ['primary_name', 'tenant_name'],
    adds: 'how they paid (or what\'s left to pay), their sign-in button, and a copy of their signed application',
    heading: (v, x) => x.pay === 'unpaid_venmo' ? '🎉 You\'re approved!' : `🎉 Welcome to ${e(v.tenant_name)}!`,
    details: (v, x) => {
      const pay = ({
        card: ok('✓ Your card payment cleared. Your membership is active.'),
        free: ok('✓ Your discount covered the whole price, so there\'s nothing to pay. Your membership is active.'),
        venmo_verified: ok('✓ The board verified your Venmo payment. Your dues are paid in full.'),
        plan: ok('✓ Your payment plan is set up. Each payment is charged on its date, with a receipt each time. Sign in to see what\'s paid and what\'s next.'),
        unpaid_venmo: box(`<b>Last step: send your dues by Venmo</b><br>Send them to <b>@${e(v.venmo_handle)}</b>. We'll email you when the board sees it.`, 'warn'),
        other: para('A board member will be in touch about payment.'),
      } as Record<string, string>)[String(x.pay ?? 'other')] ?? '';
      const signIn = x.noApp
        ? small(`You can manage your membership online any time at ${link(memberHome(v))}. Your email or phone is all you need.`)
        : button(`Sign in to ${String(v.tenant_name ?? 'the club')}`, v.sign_in_link)
          + small(`This sign-in link works once and expires in 7 days. If it expires, get a new one at ${link(`${String(v.club_url ?? '')}/m/login.html`, 'your member login page')}.`);
      return pay + signIn + signedCopy(x);
    },
    variants: [
      { id: 'card', label: 'Paid by card', x: { pay: 'card', attached: true } },
      { id: 'free', label: 'Nothing to pay', x: { pay: 'free', attached: true } },
      { id: 'venmo_verified', label: 'Venmo verified', x: { pay: 'venmo_verified' } },
      { id: 'unpaid_venmo', label: 'Venmo still to pay', x: { pay: 'unpaid_venmo' } },
      { id: 'plan', label: 'Payment plan', x: { pay: 'plan', attached: true } },
      { id: 'other', label: 'Payment to sort out', x: { pay: 'other' } },
      { id: 'card_no_app', label: 'Doesn\'t use the app', x: { pay: 'card', noApp: true, attached: true } },
    ],
  },

  // ─── Payments ──────────────────────────────────────────────────────────
  {
    key: 'payment_verified_venmo', section: 'payments',
    label: 'Venmo payment verified',
    when: 'When the board confirms a Venmo payment from a family who\'s already approved.',
    default_subject: 'Payment verified: you\'re paid in full at {{tenant_name}}',
    default_message: '<p>Hi {{primary_name}},</p><p>The board verified your Venmo payment. Your dues are paid in full and your membership is active for the season.</p>',
    placeholders: ['primary_name', 'tenant_name'],
    adds: 'a button to their member page',
    heading: () => '✓ Payment verified',
    details: v => button('Open my member page', memberHome(v)),
  },
  {
    key: 'plan_payment_received', section: 'payments',
    label: 'Plan payment received',
    when: 'Each time a payment-plan payment goes through.',
    default_subject: 'Your {{tenant_name}} payment went through',
    default_message: '<p>Hi {{family_name}},</p><p>Thanks! Your payment went through.</p>',
    placeholders: ['family_name', 'tenant_name', 'amount'],
    adds: 'the amount, what\'s next (or "paid in full"), and a button to their member page',
    heading: (_v, x) => x.final ? '✓ You\'re paid in full!' : '✓ Payment received',
    details: (v, x) => (x.final
      ? ok(`We charged ${e(v.amount)}. Your dues are paid in full for the season.`)
      : box(`We charged ${e(v.amount)} to your saved card.${v.next_amount ? ` Your next payment of <b>${e(v.next_amount)}</b> is on <b>${e(v.next_due_date)}</b>.` : ''}`))
      + small('Keep this email as your receipt.') + button('Open my member page', memberHome(v)),
    variants: [
      { id: 'partial', label: 'More to go', x: { final: false } },
      { id: 'final', label: 'Paid in full', x: { final: true } },
    ],
  },
  {
    key: 'plan_payment_failed', section: 'payments',
    label: 'Plan payment declined',
    when: 'When a payment-plan card is declined.',
    default_subject: 'Your card was declined: {{tenant_name}} payment plan',
    default_message: '<p>Hi {{family_name}},</p><p>We tried to charge your card for your {{tenant_name}} payment plan, but it was declined.</p><p>Common reasons are an expired card, a new billing address, or a daily limit. Reply to this email if you need help.</p>',
    placeholders: ['family_name', 'tenant_name', 'amount'],
    adds: 'the amount, what happens next, and an "Update my card" button',
    heading: () => '⚠ Card declined',
    details: v => box(`<b>${e(v.amount)}</b>${v.sequence ? ` (payment ${e(v.sequence)})` : ''}<br>We'll try the card again over the next two weeks. If it still can't be charged, your membership is canceled. Updating your card pays it right away.`, 'warn')
      + button('Update my card', `${String(v.club_url ?? '')}/m/#plan`),
  },
  {
    key: 'plan_cancelled', section: 'payments',
    label: 'Plan ended, membership canceled',
    when: 'When a payment plan ends: the card kept failing, it wasn\'t paid by the deadline, or the family canceled.',
    default_subject: 'Your {{tenant_name}} membership is canceled',
    default_message: '<p>Hi {{family_name}},</p><p>Your {{tenant_name}} membership is canceled because {{reason}}.</p><p>Questions? Reply to this email to reach the board.</p>',
    placeholders: ['family_name', 'tenant_name', 'reason'],
    adds: 'what was paid, how to come back and what it costs, and a "Reinstate" button',
    heading: () => 'Your membership is canceled',
    details: v => box(`Your gate access and keyfobs are off until you reinstate. The ${e(v.paid)} you've paid isn't refunded.<br><br><b>To come back:</b> pay what's overdue (${e(v.owed)}) plus the ${e(v.fee)} reactivation fee, ${e(v.total)} in all. Your plan then carries on.`, 'warn')
      + button('Reinstate my membership', v.manage_url),
  },

  // ─── Renewals ──────────────────────────────────────────────────────────
  {
    key: 'renewal_invite', section: 'renewals',
    label: 'Renewal message',
    when: 'When the board sends the renewal message from Members → Renewals. What you type there becomes the middle of this email.',
    default_subject: 'Time to renew your {{tenant_name}} membership for {{season}}',
    default_message: '<p>Hi {{family_name}},</p><p>{{message}}</p>',
    placeholders: ['family_name', 'tenant_name', 'season', 'message'],
    adds: 'their own "Renew my membership" button and how renewing works',
    heading: v => `🏊 Renew for ${e(v.season)}`,
    details: v => button('Renew my membership', v.renew_link)
      + small('Tap the button, check it over, accept the club\'s policies and sign, then pay in full or with a payment plan. No password needed. This link is just for your household, so please don\'t forward it.'),
  },
  {
    key: 'auto_renew_notice', section: 'renewals',
    label: 'One-tap renewal: ready to approve',
    when: 'When renewals open, to families who chose one-tap renewal, and once more a week later if they haven\'t approved.',
    default_subject: 'Your {{season}} {{tenant_name}} renewal is ready to approve',
    default_message: '<p>Hi {{family_name}},</p><p>Your {{tenant_name}} renewal for {{season}} is ready, filled in from last season.</p><p>Not coming back this season? Just ignore this. Nothing happens unless you approve.</p>',
    placeholders: ['family_name', 'tenant_name', 'season', 'amount'],
    adds: 'the price, that nothing is charged until they approve, and a "Review and approve" button',
    heading: v => `🏊 Your ${e(v.season)} renewal is ready`,
    details: v => box(`<span style="font-size:24px;font-family:Georgia,serif;font-weight:600;color:#0a3b5c">${e(v.amount)}</span><br>for the ${e(v.season)} season, with your saved card.`)
      + para('Check it over, accept the club\'s policies and sign, and approve. You can also switch to a payment plan or another card. <b>Nothing is charged until you approve.</b>')
      + button('Review and approve', v.manage_url),
  },
  {
    key: 'auto_renew_charged', section: 'renewals',
    label: 'One-tap renewal: receipt',
    when: 'Right after a family approves their renewal and their saved card is charged.',
    default_subject: 'You\'re all set for {{season}} at {{tenant_name}}',
    default_message: '<p>Hi {{family_name}},</p><p>Thanks for renewing! See you at the pool.</p>',
    placeholders: ['family_name', 'tenant_name', 'season', 'amount'],
    adds: 'the amount charged and the season it covers',
    heading: v => `✅ You're renewed for ${e(v.season)}`,
    details: v => ok(`We charged ${e(v.amount)} to your saved card. Your membership is paid through the ${e(v.season)} season.`)
      + small('Keep this email as your receipt.') + button('Open my member page', memberHome(v)),
  },

  // ─── Parties ───────────────────────────────────────────────────────────
  {
    key: 'party_request_received', section: 'parties',
    label: 'Party request received',
    when: 'When a member asks to book a party that needs the board\'s OK.',
    default_subject: 'Party request received: {{tenant_name}}',
    default_message: '<p>Hi {{primary_name}},</p><p>Thanks for asking to book {{party_title}}. The board will get back to you shortly.</p>',
    placeholders: ['primary_name', 'tenant_name', 'party_title'],
    adds: 'the date and time, and what happens next',
    heading: () => '🎉 Got your party request',
    details: v => box(`<b>${e(v.party_date)}</b>${v.party_time ? ` at <b>${e(v.party_time)}</b>` : ''}`)
      + para('If it\'s approved, you\'ll pay in the app to book it. It goes on the club calendar once it\'s paid.'),
  },
  {
    key: 'party_approved_pay', section: 'parties',
    label: 'Party approved, payment needed',
    when: 'When the board approves a party that hasn\'t been paid for yet.',
    default_subject: 'Your party is approved: pay to book it',
    default_message: '<p>Hi {{primary_name}},</p><p>Good news: the board approved {{party_title}}.</p>',
    placeholders: ['primary_name', 'tenant_name', 'party_title', 'price'],
    adds: 'the date, time and fee, how to pay, and a "Pay for my party" button',
    heading: () => '✓ Party approved',
    details: v => box(`<b>${e(v.party_date)}</b>${v.party_time ? ` at <b>${e(v.party_time)}</b>` : ''} · ${e(v.price)} party fee`)
      + para(`To book it, pay in the app by card (the card fee is added)${v.venmo_handle ? `, or send ${e(v.price)} by Venmo to <b>@${e(v.venmo_handle)}</b> and tap "I paid by Venmo"` : ''}. Until it's paid, the time is only held for a short while.`)
      + button('Pay for my party', v.member_url),
  },
  {
    key: 'party_confirmed', section: 'parties',
    label: 'Party booked',
    when: 'When a party is paid for and on the calendar.',
    default_subject: '🎉 Your party is booked',
    default_message: '<p>Hi {{primary_name}},</p><p>Payment received. {{party_title}} is booked and on the {{tenant_name}} calendar.</p><p>If anything changes, reply to this email.</p>',
    placeholders: ['primary_name', 'tenant_name', 'party_title'],
    adds: 'the date and time, and a button to their member page',
    heading: () => '🎉 It\'s booked!',
    details: v => box(`<b>${e(v.party_date)}</b>${v.party_time ? ` at <b>${e(v.party_time)}</b>` : ''}`) + button('Open my member page', memberHome(v)),
  },
  {
    key: 'party_rejected', section: 'parties',
    label: 'Party not approved',
    when: 'When the board turns down a party request.',
    default_subject: 'Update on your party request: {{tenant_name}}',
    default_message: '<p>Hi {{primary_name}},</p><p>Unfortunately, we can\'t approve {{party_title}} for {{party_date}}. You\'re welcome to pick another time in the app.</p>',
    placeholders: ['primary_name', 'tenant_name', 'party_title', 'party_date'],
    adds: 'the board\'s note, if you wrote one',
    heading: () => 'Party request not approved',
    details: v => boardNote(v),
  },

  // ─── Family changes ────────────────────────────────────────────────────
  {
    key: 'household_member_added', section: 'family',
    label: 'Family member added',
    when: 'When a family adds someone to their membership in the app.',
    default_subject: 'New family member added: {{tenant_name}}',
    default_message: '<p>Hi {{primary_name}},</p><p>You added {{member_name}} ({{member_role}}) to the {{family_name}} membership.</p><p>If you didn\'t make this change, reply to this email so the board can look into it.</p>',
    placeholders: ['primary_name', 'member_name', 'member_role', 'family_name', 'tenant_name'],
    adds: 'a copy of what they signed, and a button to their member page',
    heading: () => '✓ Your family is updated',
    details: (v, x) => (x.attached ? small(`📎 A signed copy is attached, with the policies ${e(v.member_name)} accepted and the signature on file. Please keep it for your records.`) : '')
      + button('Open my member page', memberHome(v)),
  },
];

/** The exact versions the senders still name, mapped to the merged emails. */
const ALIASES: Record<string, { key: string; x: Variant }> = (() => {
  const a: Record<string, { key: string; x: Variant }> = {
    application_received_venmo: { key: 'application_received', x: { pay: 'venmo' } },
    application_received_other: { key: 'application_received', x: { pay: 'other' } },
    plan_installment_paid_partial: { key: 'plan_payment_received', x: { final: false } },
    plan_installment_paid_final: { key: 'plan_payment_received', x: { final: true } },
    plan_installment_failed: { key: 'plan_payment_failed', x: {} },
  };
  const welcome: Record<string, string> = {
    stripe_paid: 'card', free: 'free', venmo_verified: 'venmo_verified',
    unpaid_venmo: 'unpaid_venmo', plan_first: 'plan', other: 'other',
  };
  for (const [suffix, pay] of Object.entries(welcome)) {
    a[`application_approved_${suffix}`] = { key: 'welcome', x: { pay } };
    a[`application_approved_${suffix}_no_app`] = { key: 'welcome', x: { pay, noApp: true } };
  }
  return a;
})();

/** Old version names → merged email key, for the Emails page's old links. */
export const EMAIL_ALIASES: Record<string, string> = Object.fromEntries(Object.entries(ALIASES).map(([k, v]) => [k, v.key]));

const REGISTRY_MAP: Record<string, EmailDef> = Object.fromEntries(EMAIL_REGISTRY.map(d => [d.key, d]));

export function getRegistryEntry(key: string): EmailDef | null {
  return REGISTRY_MAP[key] ?? REGISTRY_MAP[ALIASES[key]?.key ?? ''] ?? null;
}

/** The email a sender's key means, and the version of Poolside's part. */
export function resolveEmail(key: string): { def: EmailDef; x: Variant } | null {
  if (REGISTRY_MAP[key]) return { def: REGISTRY_MAP[key], x: {} };
  const al = ALIASES[key];
  return al && REGISTRY_MAP[al.key] ? { def: REGISTRY_MAP[al.key], x: { ...al.x } } : null;
}

// Substitute {{var}} in a string with HTML-escaped values from `vars`. Missing
// vars become empty strings.
export function substitute(template: string, vars: Vars): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => {
    const v = vars[name];
    return v == null ? '' : escHtml(String(v));
  });
}

/**
 * What a board types, made safe: paragraphs, line breaks, bold, italic,
 * underline, lists and links (http, https, mailto, or a {{placeholder}}).
 * Everything else is dropped, keeping the words.
 */
export function cleanMessage(html: string): string {
  let s = String(html ?? '').slice(0, 20000);
  s = s.replace(/<(script|style|iframe|object|embed|template|svg|math)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<div[^>]*>/gi, '<p>').replace(/<\/div\s*>/gi, '</p>');
  s = s.replace(/<(\/?)([a-z0-9]+)([^>]*)>/gi, (_m, close: string, tag: string, attrs: string) => {
    const t = tag.toLowerCase().replace(/^strong$/, 'b').replace(/^em$/, 'i');
    if (!['p', 'br', 'b', 'i', 'u', 'ul', 'ol', 'li', 'a'].includes(t)) return '';
    if (close) return t === 'br' ? '' : `</${t}>`;
    if (t === 'a') {
      const href = /href\s*=\s*"([^"]*)"|href\s*=\s*'([^']*)'/i.exec(attrs);
      const url = (href?.[1] ?? href?.[2] ?? '').trim();
      return /^(https?:|mailto:|\{\{\s*[a-z_]+\s*\}\})/i.test(url) ? `<a href="${url.replace(/"/g, '&quot;')}">` : '<a>';
    }
    return t === 'br' ? '<br>' : `<${t}>`;
  });
  return s.replace(/<p>\s*<\/p>/g, '').trim();
}

/** Put an email together: Poolside's heading, the club's message, Poolside's part. */
export function composeEmail(
  key: string, customSubject: string | null, customMessage: string | null, vars: Vars,
  extra: Variant = {},
): { subject: string; html: string; def: EmailDef | null } {
  const hit = resolveEmail(key);
  if (!hit) return { subject: '', html: '', def: null };
  const { def } = hit;
  const x = { ...hit.x, ...extra };
  const subject = substitute(customSubject || def.default_subject, vars).replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const message = substitute(cleanMessage(customMessage || def.default_message), vars)
    .replace(/<p>/g, '<p style="margin:0 0 12px;color:#334155;line-height:1.6">')
    .replace(/<a href=/g, '<a style="color:#0a3b5c" href=');
  const logo = vars.__logo_url ? `<p style="margin:0 0 16px"><img src="${e(vars.__logo_url)}" alt="${e(vars.tenant_name)}" style="max-height:56px;max-width:200px"></p>` : '';
  const content = `${logo}<h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 12px">${def.heading(vars, x)}</h2>
    <div style="font-size:15px">${message}</div>${def.details ? def.details(vars, x) : ''}`;
  return {
    subject,
    html: emailShell({ tenantName: String(vars.tenant_name ?? ''), clubUrl: String(vars.club_url ?? ''), contentHtml: content }),
    def,
  };
}

// Look up tenant override (if any) for the given key.
async function loadOverride(sb: SupabaseClient, tenantId: string, key: string): Promise<{ subject: string; body_html: string; enabled: boolean } | null> {
  const { data } = await sb.from('email_templates')
    .select('subject, body_html, enabled')
    .eq('tenant_id', tenantId).eq('key', key).maybeSingle();
  return (data as { subject: string; body_html: string; enabled: boolean } | null) ?? null;
}

/**
 * Send one of the 15 emails, with the club's own subject and message if it
 * changed them, or not at all if it switched the email off. Never throws.
 */
export async function renderAndSend(
  sb: SupabaseClient,
  args: {
    tenantId: string;
    templateKey: string;
    to: string;
    variables: Vars;
    replyTo?: string;
    attachments?: EmailAttachment[];
  },
): Promise<{ sent: boolean; error?: string; suppressed?: boolean }> {
  const hit = resolveEmail(args.templateKey);
  if (!hit) return { sent: false, error: `unknown template key: ${args.templateKey}` };
  if (!args.to) return { sent: false, error: 'no recipient' };

  let subject: string | null = null, message: string | null = null;
  try {
    const ovr = await loadOverride(sb, args.tenantId, hit.def.key);
    if (ovr) {
      if (!ovr.enabled) return { sent: false, suppressed: true };
      subject = ovr.subject || null;
      message = ovr.body_html || null;
    }
  } catch { /* the default wording */ }

  // The club's name, address and logo, whatever the sender passed.
  const vars: Vars = { ...args.variables };
  try {
    const [{ data: tenant }, { data: sv }] = await Promise.all([
      sb.from('tenants').select('display_name, slug').eq('id', args.tenantId).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', args.tenantId).maybeSingle(),
    ]);
    if (tenant) {
      if (!vars.tenant_name) vars.tenant_name = tenant.display_name as string;
      if (!vars.club_url) vars.club_url = `https://${tenant.slug as string}.poolsideapp.com`;
    }
    const logo = ((sv?.value as Record<string, unknown> | undefined)?.branding as Record<string, unknown> | undefined)?.logo_url;
    if (logo) vars.__logo_url = String(logo);
  } catch { /* keep what we have */ }

  const out = composeEmail(args.templateKey, subject, message, vars, { attached: !!args.attachments?.length });
  return await sendEmail({ to: args.to, subject: out.subject, html: out.html, replyTo: args.replyTo, attachments: args.attachments });
}

/** The Emails page's preview: an email, a version of it, sample details. */
export function renderPreview(
  key: string, customSubject: string | null, customMessage: string | null, vars: Vars, variantId?: string | null,
): { subject: string; html: string } {
  const def = getRegistryEntry(key);
  if (!def) return { subject: '(unknown email)', html: '' };
  const v = def.variants?.find(x => x.id === variantId) ?? def.variants?.[0];
  const out = composeEmail(def.key, customSubject, customMessage, vars, v?.x ?? {});
  return { subject: out.subject, html: out.html };
}

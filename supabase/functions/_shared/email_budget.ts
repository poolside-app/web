// =============================================================================
// email_budget.ts — how many more emails we can send today, and the queue
// =============================================================================
// Resend's free tier is 3,000 emails a month but only 100 in a day. The daily
// number is the one that bites: a 150-household invite blast stops at 100 and
// the last 50 families simply never hear from the club. Nothing raises an
// error — the blast just reports a smaller number than there are households.
//
// So bulk mail is queued and drained inside a budget, and a 150-household send
// goes out over two mornings on its own.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Sends allowed per UTC day.
 *
 * Deliberately 80 rather than Resend's 100. Transactional mail — sign-in
 * links, receipts, approvals — sends immediately and is only logged where a
 * caller passes a client, so the count is a floor rather than an exact figure.
 * The 20-email gap is the margin for what we did not see. Raise it via
 * EMAIL_DAILY_CAP once the account is on a paid plan.
 */
export function dailyCap(): number {
  const raw = Number(Deno.env.get('EMAIL_DAILY_CAP') ?? '');
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 80;
}

/** Emails logged so far today, UTC — the same boundary Resend resets on. */
export async function sentToday(sb: SupabaseClient): Promise<number> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const { count, error } = await sb.from('email_log')
    .select('id', { count: 'exact', head: true })
    .gte('sent_at', start.toISOString())
    .eq('success', true);
  if (error) {
    // Fail CLOSED. If we cannot tell how many have gone out, sending more
    // risks burning the allowance the club's own members need for sign-in
    // links; waiting a day costs nothing by comparison.
    console.error('email budget: count failed, assuming spent:', error.message);
    return dailyCap();
  }
  return count ?? 0;
}

export async function remainingToday(sb: SupabaseClient): Promise<number> {
  return Math.max(0, dailyCap() - await sentToday(sb));
}

/** Record a send. Best-effort: a failed log must never fail the email. */
export async function recordEmail(
  sb: SupabaseClient,
  args: { tenantId?: string | null; to: string; category?: string; success: boolean; error?: string | null; source?: string },
): Promise<void> {
  try {
    await sb.from('email_log').insert({
      tenant_id: args.tenantId ?? null,
      to_email:  args.to,
      category:  args.category ?? 'transactional',
      success:   args.success,
      error:     args.error ?? null,
      source:    args.source ?? null,
    });
  } catch (e) {
    console.error('email log write failed:', (e as Error).message);
  }
}

export type QueuedEmail = {
  to: string;
  subject: string;
  html: string;
  replyTo?: string | null;
  category?: string;
  notBefore?: string | null;
};

/**
 * Put bulk mail in the queue instead of sending it.
 *
 * Returns how many rows were written. Callers should report this to the admin
 * as "queued", never as "sent" — the difference is the whole point, and a
 * board member told 150 emails went out when 80 did would find out from a
 * neighbour rather than from us.
 */
export async function enqueueEmails(
  sb: SupabaseClient,
  tenantId: string,
  emails: QueuedEmail[],
): Promise<number> {
  const rows = emails
    .filter(e => e.to && e.subject && e.html)
    .map(e => ({
      tenant_id:  tenantId,
      to_email:   e.to,
      subject:    e.subject,
      html:       e.html,
      reply_to:   e.replyTo ?? null,
      category:   e.category ?? 'bulk',
      not_before: e.notBefore ?? null,
      status:     'queued',
    }));
  if (!rows.length) return 0;
  const { error } = await sb.from('email_queue').insert(rows);
  if (error) {
    console.error('email enqueue failed:', error.message);
    return 0;
  }
  return rows.length;
}

/**
 * Send as much of the queue as today's budget allows.
 *
 * Oldest first, so a blast started on Monday finishes before one started on
 * Tuesday begins. Four failed attempts retires a row: a permanently bouncing
 * address must not be able to eat the club's whole allowance every morning.
 */
export async function drainEmailQueue(
  sb: SupabaseClient,
  opts: { max?: number } = {},
): Promise<{ sent: number; failed: number; remaining_budget: number; still_queued: number }> {
  const { sendEmail } = await import('./send_email.ts');
  const budget = Math.min(await remainingToday(sb), opts.max ?? Number.MAX_SAFE_INTEGER);
  let sent = 0, failed = 0;

  if (budget > 0) {
    const nowIso = new Date().toISOString();
    const { data: batch } = await sb.from('email_queue')
      .select('id, tenant_id, to_email, subject, html, reply_to, category, attempts')
      .eq('status', 'queued')
      .or(`not_before.is.null,not_before.lte.${nowIso}`)
      .order('created_at', { ascending: true })
      .limit(budget);

    for (const row of (batch ?? [])) {
      const res = await sendEmail({
        to: row.to_email as string,
        subject: row.subject as string,
        html: row.html as string,
        replyTo: (row.reply_to as string) || undefined,
      });
      const attempts = Number(row.attempts ?? 0) + 1;
      if (res.sent) {
        sent++;
        await sb.from('email_queue')
          .update({ status: 'sent', attempts, sent_at: new Date().toISOString(), last_error: null })
          .eq('id', row.id as string);
      } else {
        failed++;
        await sb.from('email_queue')
          .update({
            status: attempts >= 4 ? 'failed' : 'queued',
            attempts,
            last_error: (res.error ?? 'unknown').slice(0, 500),
          })
          .eq('id', row.id as string);
      }
      await recordEmail(sb, {
        tenantId: row.tenant_id as string,
        to: row.to_email as string,
        category: (row.category as string) || 'bulk',
        success: res.sent,
        error: res.error ?? null,
        source: 'email_queue.drain',
      });
    }
  }

  const { count } = await sb.from('email_queue')
    .select('id', { count: 'exact', head: true }).eq('status', 'queued');

  return {
    sent,
    failed,
    remaining_budget: await remainingToday(sb),
    still_queued: count ?? 0,
  };
}

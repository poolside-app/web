// =============================================================================
// send_email.ts — single Resend wrapper used by every function that emails
// =============================================================================
// Centralizes: env reads, From-address default, error handling, logging.
// Returns { sent, error?, devLink? } so callers can fall back to dev_link
// when RESEND_API_KEY is missing (early-stage testing without a key).
// =============================================================================

const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM    = Deno.env.get('RESEND_FROM') || 'Poolside <noreply@poolsideapp.com>';

export type SendResult = { sent: boolean; error?: string; id?: string };

export async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
}): Promise<SendResult> {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not set' };
  if (!args.to || !args.subject || !args.html) {
    return { sent: false, error: 'to, subject, html required' };
  }
  try {
    const body: Record<string, unknown> = {
      from: RESEND_FROM,
      to: [args.to],
      subject: args.subject,
      html: args.html,
    };
    if (args.replyTo) body.reply_to = args.replyTo;
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { sent: false, error: `Resend ${res.status}: ${txt.slice(0, 200)}` };
    }
    const data = await res.json();
    return { sent: true, id: data?.id };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

export function escHtml(s: string | number | null | undefined): string {
  const map: Record<string, string> = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  return String(s ?? '').replace(/[&<>"']/g, c => map[c] || c);
}

// Standard email shell — branded header + content slot + footer. All
// templates use this so they look consistent without each duplicating layout.
export function emailShell(args: {
  tenantName: string;
  clubUrl: string;
  contentHtml: string;
  preheader?: string;       // hidden text for inbox preview
}): string {
  const preheader = args.preheader
    ? `<div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${escHtml(args.preheader)}</div>`
    : '';
  return `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      ${preheader}
      ${args.contentHtml}
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0">
      <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.5">From <a href="${args.clubUrl}" style="color:#0a3b5c">${escHtml(args.clubUrl.replace(/^https?:\/\//, ''))}</a> · Powered by <a href="https://poolsideapp.com" style="color:#0a3b5c">Poolside</a></p>
    </div>
  `;
}

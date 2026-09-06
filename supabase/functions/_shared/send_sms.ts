// =============================================================================
// send_sms.ts — one place that talks to Twilio
// =============================================================================
// member_auth, renewals and payment_plans each grew their own copy of this
// call. New senders should use this one rather than adding a fourth; the older
// three can migrate when they are next touched, since rewriting working
// payment and login paths for tidiness alone is not worth the risk.
//
// Every send goes through the club's own cap accounting, so one club blasting
// its roster can never spend another club's allowance.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkSmsCap, recordSms, checkGlobalSmsKillSwitch } from './sms_cap.ts';

export type SmsResult = {
  sent: boolean;
  error?: string;
  capped?: boolean;
  /** 'club' = this club's monthly allowance; 'platform' = the global daily
   *  kill switch. Different owners, different fixes — do not merge them. */
  capped_by?: 'club' | 'platform';
};

export async function sendSms(args: {
  sb: SupabaseClient;
  tenantId: string;
  tenantPlan?: string | null;
  to: string;
  body: string;
  /** Which per-club budget this draws from — 'campaign' for blasts. */
  kind?: string;
}): Promise<SmsResult> {
  const kind = args.kind ?? 'campaign';

  if (Deno.env.get('SMS_DEV_MODE') === '1') {
    return { sent: false, error: 'SMS_DEV_MODE on (testing)' };
  }

  const gate = await checkGlobalSmsKillSwitch(args.sb, args.to);
  if (gate.blocked) {
    return {
      sent: false, capped: true, capped_by: 'platform',
      error: `Poolside's daily SMS safety limit was reached (${gate.used}/${gate.cap}). Texts resume automatically; contact Poolside to raise it for a big send.`,
    };
  }
  const cap = await checkSmsCap(args.sb, args.tenantId, kind, args.tenantPlan ?? undefined);
  if (cap.blocked) {
    return {
      sent: false, capped: true, capped_by: 'club',
      error: `This club's monthly SMS allowance is used up (${cap.used}/${cap.cap}). Resets in ${cap.days_until_reset} day${cap.days_until_reset === 1 ? '' : 's'}.`,
    };
  }

  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const tok = Deno.env.get('TWILIO_AUTH_TOKEN');
  if (!sid || !tok) return { sent: false, error: 'Twilio not configured' };

  const params: Record<string, string> = { To: args.to, Body: args.body };
  const messagingServiceSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID');
  const fromN = Deno.env.get('TWILIO_FROM_NUMBER');
  if (messagingServiceSid) params.MessagingServiceSid = messagingServiceSid;
  else if (fromN) params.From = fromN;
  else return { sent: false, error: 'No Twilio sender configured' };

  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${sid}:${tok}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { sent: false, error: `Twilio ${res.status}: ${txt.slice(0, 200)}` };
    }
    await recordSms(args.sb, args.tenantId, kind);
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

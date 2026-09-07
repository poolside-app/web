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
import type { SmsCategory } from './sms_cap.ts';
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
  kind?: SmsCategory;
  /** Where this send came from, e.g. 'gate_admin.outage'. Shows in sms_log
   *  so an admin reading their audit trail can tell a dues reminder from a
   *  login code without decoding the message body. */
  source?: string;
  /**
   * Bypass the platform-wide daily kill switch for operational alerts that
   * are themselves the product.
   *
   * The global cap exists to stop a runaway loop or a compromised key from
   * spending real money, and it deliberately applies to every category —
   * including transactional. But a gate-outage alert that gets swallowed by
   * that cap is the one text whose whole purpose is to arrive: the club is
   * paying for monitoring precisely so somebody hears about an outage.
   *
   * Safe to exempt only because the callers using this are themselves
   * bounded — the outage state machine sends at most one text per club per
   * outage. Do not set this on anything driven by a roster loop. The
   * per-recipient hourly cap still applies, so even a bug here cannot
   * hammer one phone.
   */
  critical?: boolean;
}): Promise<SmsResult> {
  const kind: SmsCategory = args.kind ?? 'campaign';
  const source = args.source ?? null;

  if (Deno.env.get('SMS_DEV_MODE') === '1') {
    return { sent: false, error: 'SMS_DEV_MODE on (testing)' };
  }

  const gate = await checkGlobalSmsKillSwitch(args.sb, args.to, { skipDailyCap: !!args.critical });
  if (gate.blocked) {
    return {
      sent: false, capped: true, capped_by: 'platform',
      error: gate.reason === 'per_recipient_hour'
        ? `This number has already received ${gate.used} texts in the past hour (limit ${gate.cap}). Try again shortly.`
        : `Poolside's daily SMS safety limit was reached (${gate.used}/${gate.cap}). Texts resume automatically; contact Poolside to raise it for a big send.`,
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
      const error = `Twilio ${res.status}: ${txt.slice(0, 200)}`;
      // Log the failure too. Without this an admin looking at their audit
      // trail sees silence for a text that was attempted and rejected,
      // which is indistinguishable from one that was never tried.
      await recordSms(args.sb, {
        tenantId: args.tenantId, category: kind, toPhone: args.to,
        success: false, error, source,
      });
      return { sent: false, error };
    }
    await recordSms(args.sb, {
      tenantId: args.tenantId, category: kind, toPhone: args.to,
      success: true, source,
    });
    return { sent: true };
  } catch (e) {
    const error = String(e);
    await recordSms(args.sb, {
      tenantId: args.tenantId, category: kind, toPhone: args.to,
      success: false, error, source,
    });
    return { sent: false, error };
  }
}

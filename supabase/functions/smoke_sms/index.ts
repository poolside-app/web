// =============================================================================
// smoke_sms — fire a one-off test SMS through Twilio
// =============================================================================
// Internal smoke utility. Gated by SMOKE_SECRET header so only the operator
// (who set the secret) can trigger sends — anon-key alone is not enough.
// Uses the same Twilio env vars the real SMS senders use, so a successful
// send here proves the production wiring end-to-end. Also obeys the global
// SMS kill-switch (SMS_GLOBAL_DAILY_CAP + SMS_PER_RECIPIENT_HOUR_CAP) so
// even an operator can't accidentally burn through SMS during testing.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { checkGlobalSmsKillSwitch } from '../_shared/sms_cap.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-smoke-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'content-type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST')   return j({ ok: false, error: 'POST only' }, 405);

  const expected = Deno.env.get('SMOKE_SECRET') || '';
  const got      = req.headers.get('x-smoke-secret') || '';
  if (!expected || got !== expected) return j({ ok: false, error: 'forbidden' }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch {}

  // ping action: just verify Twilio creds work without sending an SMS.
  // Hits /Accounts/{sid}.json (read-only) — if it returns 200, the token
  // is valid; if 401, the token is stale. Cheap, doesn't burn SMS credit.
  if (String(body.action ?? '') === 'ping') {
    const sid   = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
    const token = Deno.env.get('TWILIO_AUTH_TOKEN')  || '';
    if (!sid || !token) return j({ ok: false, error: 'creds missing', has_sid: !!sid, has_token: !!token }, 500);
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
      headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`) },
    });
    const text = await res.text();
    let twilio: unknown = text;
    try { twilio = JSON.parse(text); } catch {}
    return j({ ok: res.ok, http_status: res.status, account_sid: sid, twilio }, 200);
  }

  const to  = String(body.to  ?? '').trim();
  const msg = String(body.body ?? 'Poolside smoke test - SMS wiring is live.');
  if (!to) return j({ ok: false, error: '"to" required (E.164, e.g. +19255550100)' }, 400);

  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const gate = await checkGlobalSmsKillSwitch(sb, to);
  if (gate.blocked) return j({ ok: false, error: 'SMS kill-switch tripped', gate }, 429);

  const sid    = Deno.env.get('TWILIO_ACCOUNT_SID') || '';
  const token  = Deno.env.get('TWILIO_AUTH_TOKEN')  || '';
  const msgSid = Deno.env.get('TWILIO_MESSAGING_SERVICE_SID') || '';
  const from   = Deno.env.get('TWILIO_FROM_NUMBER') || '';
  if (!sid || !token) return j({ ok: false, error: 'Twilio creds missing', has_sid: !!sid, has_token: !!token }, 500);

  const params = new URLSearchParams({ To: to, Body: msg });
  if (msgSid) params.set('MessagingServiceSid', msgSid);
  else if (from) params.set('From', from);
  else return j({ ok: false, error: 'No sender configured (need MessagingServiceSid or From)' }, 500);

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method:  'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${sid}:${token}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  const text = await res.text();
  let twilio: unknown = text;
  try { twilio = JSON.parse(text); } catch {}
  return j({ ok: res.ok, http_status: res.status, sent_to: to, used: msgSid ? 'messaging_service' : 'from_number', twilio }, res.ok ? 200 : 502);
});

// =============================================================================
// renewals — season-open dues blast (email/SMS) to prior members
// =============================================================================
// Auth: tenant admin token (HS256, kind='tenant_admin'). Tenant scope is
// pulled from the token, never the body. Caller needs the 'renewals' scope
// (or owner template). Front-end is /club/admin/members.html#renewals.
//
// Actions:
//
//   { action: 'send_blast', audience, channels, message? }
//     • audience: 'all' | 'lapsed' | 'last_season'
//          'all'         — every active household
//          'lapsed'      — dues_paid_for_year=false (didn't pay this year)
//          'last_season' — paid_until_year = current_year - 1 (paid last year, not yet this year)
//     • channels: array — any combination of ['email','sms']
//     • message: optional admin override of the body copy
//     → { ok, sent: { email, sms }, skipped: { no_contact, send_fail }, dev_links?: [...] }
//
// Per recipient: generates a 7-day single-use member_magic_link, embeds the
// verify URL in email + SMS body. Recipient = first active adult in each
// household with email or phone. One blast per household.
//
// Early-bird config lives in settings.value.renewals.early_bird and is
// managed via tenant_settings.save (server-side merge keeps unrelated keys).
// This function reads it to compose the body's discount line.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { checkSmsCap, recordSms } from '../_shared/sms_cap.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const RESEND_FROM    = Deno.env.get('RESEND_FROM') || 'Poolside <noreply@poolsideapp.com>';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

type Payload = { sub: string; kind: string; tid: string; slug: string; scopes?: string[]; role_template?: string; is_super?: boolean };

async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as Record<string, unknown>;
    if (payload.kind !== 'tenant_admin') return null;
    if (!payload.sub || !payload.tid || !payload.slug) return null;
    return payload as unknown as Payload;
  } catch { return null; }
}

function hasScope(p: Payload, scope: string): boolean {
  if (p.is_super) return true;
  if (p.role_template === 'owner') return true;
  const scopes = Array.isArray(p.scopes) ? p.scopes : [];
  return scopes.includes(scope);
}

function randomToken(): string {
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function escHtml(s: string): string {
  const map: Record<string, string> = { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' };
  return s.replace(/[&<>"']/g, c => map[c] || c);
}

async function sendRenewalEmail(args: {
  to: string; tenantName: string; clubUrl: string; verifyLink: string; memberName: string;
  intro: string; earlyBirdLine: string;
}): Promise<{ sent: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not set' };
  const html = `
    <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a">
      <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 8px">Time to renew your ${escHtml(args.tenantName)} membership</h2>
      <p style="margin:0 0 16px;color:#475569;line-height:1.55">Hi ${escHtml(args.memberName || 'there')}, ${escHtml(args.intro)}</p>
      ${args.earlyBirdLine ? `<p style="margin:0 0 16px;padding:12px 14px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:6px;color:#7c2d12;font-weight:600">${escHtml(args.earlyBirdLine)}</p>` : ''}
      <p style="margin:24px 0">
        <a href="${args.verifyLink}" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;display:inline-block">Sign in & pay dues →</a>
      </p>
      <p style="margin:0 0 8px;color:#64748b;font-size:13px;line-height:1.5">Once signed in you'll see how to pay (Venmo or card). The link is single-use and good for 7 days.</p>
      <p style="margin:0;color:#64748b;font-size:13px;line-height:1.5">Trouble with the button? Copy this link:<br><code style="font-size:12px;word-break:break-all;color:#0a3b5c">${args.verifyLink}</code></p>
      <hr style="border:0;border-top:1px solid #e5e7eb;margin:28px 0">
      <p style="margin:0;color:#94a3b8;font-size:12px">From <a href="${args.clubUrl}" style="color:#0a3b5c">${escHtml(args.clubUrl.replace(/^https?:\/\//, ''))}</a>. You're receiving this because your household is on the membership list.</p>
    </div>
  `;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: RESEND_FROM,
        to: [args.to],
        subject: `Renew your ${args.tenantName} membership`,
        html,
      }),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { sent: false, error: `Resend ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

async function sendRenewalSms(args: {
  to: string; tenantName: string; verifyLink: string; earlyBirdLine: string;
}): Promise<{ sent: boolean; error?: string }> {
  if (Deno.env.get('SMS_DEV_MODE') === '1') return { sent: false, error: 'SMS_DEV_MODE on (testing)' };
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const tok = Deno.env.get('TWILIO_AUTH_TOKEN');
  const fromN = Deno.env.get('TWILIO_FROM_NUMBER');
  if (!sid || !tok || !fromN) return { sent: false, error: 'TWILIO_* env vars not set' };
  const eb = args.earlyBirdLine ? ` ${args.earlyBirdLine}` : '';
  const body = `${args.tenantName}: time to renew!${eb} Sign in & pay: ${args.verifyLink} (link good 7 days)`;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(`${sid}:${tok}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: args.to, From: fromN, Body: body }).toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { sent: false, error: `Twilio ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { sent: true };
  } catch (e) {
    return { sent: false, error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  if (!hasScope(payload, 'renewals')) {
    return jsonResponse({ ok: false, error: 'Missing renewals scope' }, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  if (action === 'sms_usage') {
    const { data: tenant } = await sb.from('tenants')
      .select('id, plan').eq('id', payload.tid).maybeSingle();
    const status = await checkSmsCap(sb, payload.tid, 'campaign', tenant?.plan);
    return jsonResponse({ ok: true, plan: tenant?.plan ?? 'free', ...status });
  }

  if (action === 'list_history') {
    const { data, error } = await sb.from('audit_log')
      .select('id, created_at, summary, metadata, actor_label')
      .eq('tenant_id', payload.tid)
      .eq('kind', 'renewals.send_blast')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, blasts: data ?? [] });
  }

  if (action === 'send_blast') {
    const audience = String(body.audience ?? 'lapsed');
    const channels = Array.isArray(body.channels) ? body.channels.map(String) : [];
    const adminMessage = (typeof body.message === 'string' && body.message.trim()) ? body.message.trim() : '';
    if (!['all', 'lapsed', 'last_season'].includes(audience)) {
      return jsonResponse({ ok: false, error: 'audience must be all, lapsed, or last_season' }, 400);
    }
    if (!channels.length || !channels.every(c => c === 'email' || c === 'sms')) {
      return jsonResponse({ ok: false, error: 'channels must include email or sms' }, 400);
    }

    const { data: tenant } = await sb.from('tenants')
      .select('id, slug, display_name, plan').eq('id', payload.tid).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Tenant not found' }, 404);

    // SMS cap pre-check: if SMS is in channels and the tenant is already at
    // or near the monthly cap, refuse early so we don't half-send and burn
    // half the cap before the admin notices.
    if (channels.includes('sms')) {
      const cap = await checkSmsCap(sb, payload.tid, 'campaign', tenant.plan);
      if (cap.blocked) {
        return jsonResponse({
          ok: false,
          error: `Monthly SMS cap reached (${cap.used}/${cap.cap}). Resets in ${cap.days_until_reset} day${cap.days_until_reset === 1 ? '' : 's'}.`,
          sms_cap: cap,
        }, 429);
      }
    }

    const { data: settingsRow } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    const eb = ((settingsRow?.value as Record<string, unknown> | undefined)?.renewals as Record<string, unknown> | undefined)?.early_bird as Record<string, unknown> | undefined;
    let earlyBirdLine = '';
    if (eb && eb.enabled && eb.deadline) {
      const deadline = String(eb.deadline);
      const cents = Number(eb.discount_cents ?? 0);
      const pct   = Number(eb.discount_percent ?? 0);
      const offCopy = cents > 0 ? `$${(cents/100).toFixed(0)} off` : (pct > 0 ? `${pct}% off` : 'Early-bird pricing');
      earlyBirdLine = `Early-bird: ${offCopy} if paid by ${deadline}.`;
    }

    const currentYear = new Date().getFullYear();
    let hhQuery = sb.from('households')
      .select('id, family_name, tier, paid_until_year, dues_paid_for_year, active')
      .eq('tenant_id', payload.tid)
      .eq('active', true);
    if (audience === 'lapsed') {
      hhQuery = hhQuery.eq('dues_paid_for_year', false);
    } else if (audience === 'last_season') {
      hhQuery = hhQuery.eq('paid_until_year', currentYear - 1);
    }
    const { data: households, error: hhErr } = await hhQuery;
    if (hhErr) return jsonResponse({ ok: false, error: hhErr.message }, 500);
    const hhList = households ?? [];
    if (!hhList.length) {
      return jsonResponse({ ok: true, sent: { email: 0, sms: 0 }, skipped: { no_contact: 0, send_fail: 0 }, total: 0 });
    }

    const hhIds = hhList.map(h => h.id);
    const { data: members } = await sb.from('household_members')
      .select('id, household_id, name, email, phone_e164, role, active')
      .in('household_id', hhIds)
      .eq('active', true);
    const byHh = new Map<string, Array<{ id: string; name: string; email: string | null; phone_e164: string | null; role: string | null }>>();
    (members ?? []).forEach(m => {
      const arr = byHh.get(m.household_id) ?? [];
      arr.push(m as { id: string; name: string; email: string | null; phone_e164: string | null; role: string | null });
      byHh.set(m.household_id, arr);
    });

    const wantEmail = channels.includes('email');
    const wantSms   = channels.includes('sms');

    const intro = adminMessage
      || `memberships are open for the ${currentYear} season. Sign in to your member home to see your tier and pay your dues.`;

    let emailSent = 0, smsSent = 0, noContact = 0, sendFail = 0;
    const devLinks: Array<{ household: string; link: string; reason: string }> = [];
    // Pre-fetched cap so we can stop SMS mid-loop if we'd exceed it. Email
    // is uncapped (handled by Resend's own quotas + future deliverability).
    const smsCapStatus = wantSms
      ? await checkSmsCap(sb, payload.tid, 'campaign', tenant.plan)
      : null;
    let smsRemaining = smsCapStatus?.remaining ?? Infinity;
    let smsCappedHit = false;

    for (const hh of hhList) {
      const adults = (byHh.get(hh.id) ?? []).filter(m => (m.role ?? 'adult') === 'adult');
      // Pick first adult with the channels we need; falls back to any adult.
      const recipient = adults.find(a => (wantEmail && a.email) || (wantSms && a.phone_e164)) || adults[0];
      if (!recipient || (!recipient.email && !recipient.phone_e164)) {
        noContact++;
        continue;
      }

      const tok = randomToken();
      const tokenHash = await sha256Hex(tok);
      const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
      await sb.from('member_magic_links').insert({
        tenant_id: tenant.id, member_id: recipient.id,
        token_hash: tokenHash, expires_at: expiresAt,
      });
      const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
      const verifyLink = `${clubUrl}/m/verify.html#token=${encodeURIComponent(tok)}`;

      let emailDone = false, smsDone = false;
      if (wantEmail && recipient.email) {
        const r = await sendRenewalEmail({
          to: recipient.email, tenantName: tenant.display_name,
          clubUrl, verifyLink, memberName: recipient.name, intro, earlyBirdLine,
        });
        if (r.sent) { emailSent++; emailDone = true; }
        else if (!RESEND_API_KEY) {
          devLinks.push({ household: hh.family_name, link: verifyLink, reason: 'RESEND_API_KEY not set' });
          emailDone = true; // counted as 'no provider' rather than send_fail
        } else {
          sendFail++;
        }
      }
      if (wantSms && recipient.phone_e164) {
        if (smsRemaining <= 0) {
          smsCappedHit = true;        // skip remaining SMS but keep emailing
        } else {
          const r = await sendRenewalSms({
            to: recipient.phone_e164, tenantName: tenant.display_name, verifyLink, earlyBirdLine,
          });
          if (r.sent) { smsSent++; smsDone = true; smsRemaining--; }
          else if (!Deno.env.get('TWILIO_ACCOUNT_SID')) {
            devLinks.push({ household: hh.family_name, link: verifyLink, reason: 'TWILIO_* not set' });
            smsDone = true;
          } else {
            sendFail++;
          }
          // Log every attempt so the cap counter stays accurate even on
          // Twilio failures (a failed campaign send still counts as 'used').
          await recordSms(sb, {
            tenantId: payload.tid,
            category: 'campaign',
            toPhone: recipient.phone_e164,
            success: r.sent,
            error: r.error ?? null,
            source: 'renewals.send_blast',
          });
        }
      }
      if (!emailDone && !smsDone) noContact++;
    }

    await sb.from('audit_log').insert({
      tenant_id: payload.tid,
      kind: 'renewals.send_blast',
      entity_type: 'tenant',
      entity_id: tenant.id,
      summary: `Sent ${emailSent} email${emailSent === 1 ? '' : 's'} + ${smsSent} SMS to ${audience} households`,
      actor_id: payload.sub,
      actor_kind: 'tenant_admin',
      actor_label: payload.sub,
      metadata: { audience, channels, total: hhList.length, email_sent: emailSent, sms_sent: smsSent, send_fail: sendFail, sms_cap_hit: smsCappedHit },
    });

    return jsonResponse({
      ok: true,
      sms_cap_hit: smsCappedHit,
      total: hhList.length,
      sent: { email: emailSent, sms: smsSent },
      skipped: { no_contact: noContact, send_fail: sendFail },
      dev_links: devLinks.length ? devLinks : undefined,
    });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

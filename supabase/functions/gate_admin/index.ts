// =============================================================================
// gate_admin — tenant-side + provider-side management of the gate add-on
// =============================================================================
// Tenant admin actions (require tenant_admin JWT, owner-only):
//   { action: 'get_status' }
//     → returns the tenant's gate_panels row (no secrets) + bridge_health
//   { action: 'request_addon', panel_type, contact_name, contact_phone, contact_email? }
//     → creates a 'requested' row + admin_task for super-admin Doug. NO
//       invoice is sent at this point (changed 2026-05-22). Doug calls the
//       contact, confirms integration, then triggers the invoice manually.
//   { action: 'update_config', panel_host, panel_admin_user, panel_admin_password }
//     → tenant fills in their panel info post-activation
//   { action: 'rotate_bridge_secret' }
//     → returns a fresh plaintext bridge_secret (one-shot — admin must save it)
//   { action: 'recent_unlocks', limit? }
//     → audit log for the tenant's own page
//   { action: 'test_unlock' }
//     → queue an unlock that bypasses dues/active-member checks
//
// Provider-side actions (require is_super JWT):
//   { action: 'super_list' }
//     → all tenants' gate_panels + bridge health
//   { action: 'super_set_status', tenant_id, status, notes? }
//     → flip status (e.g. activate Bishop Estates without payment)
//   { action: 'super_send_invoice', tenant_id, amount_cents, email?, note? }
//     → record + email a one-off invoice. Orthogonal to status — doesn't
//       change the lifecycle, just sets invoice_* columns + sends mail.
//   { action: 'super_mark_invoice_paid', tenant_id }
//     → record that the invoice cleared (Venmo/check/wire — Poolside
//       doesn't auto-collect for the gate add-on yet).
//
// Gate integration enquiries (added 2026-09-09). The intake that replaced
// the verified-template catalogue — see the migration header for why:
//   { action: 'submit_integration_request', contact_name, contact_phone, ... }
//     → owner-only. Every hardware field is optional; photos come in as
//       base64 and land in club-assets. One open request per club.
//   { action: 'my_integration_request' }
//     → the club's own latest request, whatever its status
//   { action: 'withdraw_integration_request' }
//     → owner-only; closes whatever is open
//   { action: 'super_list_integration_requests', status? }
//     → the review queue, with club names resolved
//   { action: 'super_review_integration_request', request_id, status?,
//              admin_notes?, quoted_setup_cents?, quoted_monthly_cents? }
//     → triage one request. Nothing is quoted before a human has looked.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyTenantAdmin, verifyTenantAdminOrProvider, requireOwner, requireSuper } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

// SHA-256 hex digest. Bridge secrets are stored as hashes; on rotation we
// return the plaintext once and never persist it.
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate a 32-byte random bridge secret as hex.
function randomBridgeSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Strip secrets from a gate_panels row before returning it to the admin UI.
function publicGatePanel(row: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    status: row.status,
    requested_at: row.requested_at,
    activated_at: row.activated_at,
    panel_type: row.panel_type,
    panel_host: row.panel_host,
    panel_admin_user: row.panel_admin_user,
    panel_password_set: !!row.panel_admin_password,    // boolean only, never the value
    bridge_id: row.bridge_id,
    bridge_secret_set: !!row.bridge_secret_hash,
    bridge_last_seen_at: row.bridge_last_seen_at,
    bridge_version: row.bridge_version,
    // Outage escalation state. The provider dashboard uses these to show
    // which clubs are mid-outage and whether the club has been told yet;
    // the club's own settings page uses them to explain why they got a text.
    bridge_alert_state:      row.bridge_alert_state ?? 'ok',
    bridge_provider_alerted_at: row.bridge_provider_alerted_at ?? null,
    bridge_club_alerted_at:  row.bridge_club_alerted_at ?? null,
    bridge_outage_reply:     row.bridge_outage_reply ?? null,
    bridge_outage_reply_at:  row.bridge_outage_reply_at ?? null,
    bridge_link_type:        row.bridge_link_type ?? 'unknown',
    // Flap history. A bridge cycling repeatedly is a hardware problem, and
    // the dashboard should surface that differently from "currently down".
    bridge_flap_count:        row.bridge_flap_count ?? 0,
    bridge_flap_window_start: row.bridge_flap_window_start ?? null,
    bridge_flap_alerted_at:   row.bridge_flap_alerted_at ?? null,
    notes: row.notes,
    config_locked: !!row.config_locked,
    config_locked_at: row.config_locked_at ?? null,
    config_locked_by: row.config_locked_by ?? null,
    // Contact + invoice (added 2026-05-22). Returned to BOTH tenant and
    // provider — the tenant needs invoice_sent_at/amount to render the
    // "Invoice received — please pay" card. Contact info is what the
    // tenant typed; no privacy concern returning it to them.
    contact_name:         row.contact_name ?? null,
    contact_phone:        row.contact_phone ?? null,
    contact_email:        row.contact_email ?? null,
    invoice_amount_cents: row.invoice_amount_cents ?? null,
    invoice_sent_at:      row.invoice_sent_at ?? null,
    invoice_paid_at:      row.invoice_paid_at ?? null,
    invoice_note:         row.invoice_note ?? null,
  };
}

// Compute bridge health from last_seen + status.
function bridgeHealth(row: Record<string, unknown> | null): {
  state: 'unknown' | 'never_seen' | 'online' | 'stale' | 'offline';
  last_seen_seconds_ago: number | null;
} {
  if (!row || row.status !== 'active') return { state: 'unknown', last_seen_seconds_ago: null };
  if (!row.bridge_last_seen_at) return { state: 'never_seen', last_seen_seconds_ago: null };
  const secs = (Date.now() - new Date(row.bridge_last_seen_at as string).getTime()) / 1000;
  if (secs < 30) return { state: 'online', last_seen_seconds_ago: Math.round(secs) };
  if (secs < 300) return { state: 'stale', last_seen_seconds_ago: Math.round(secs) };
  return { state: 'offline', last_seen_seconds_ago: Math.round(secs) };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  // Peek at the action so we know whether to accept provider tokens. The
  // super_* family lives on /admin/gate-integrations.html (provider side),
  // everything else is tenant-side.
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  // ── cron_check_bridges (no admin auth — gated by CRON_SECRET) ──────
  // Runs every 5 minutes via pg_cron. Two-stage escalation:
  //
  //   ok               -- 10 min silent --> alerted_provider  (Doug only)
  //   alerted_provider -- 30 min silent --> alerted_club       (text + email)
  //   either           -- bridge back   --> ok
  //
  // The middle state is the product. Most outages are a router blip or a
  // brief power flicker; giving Doug a 20-minute head start means the ones
  // that self-heal are never seen by the customer at all. A club that is
  // told about every transient blip stops reading the alerts, which is
  // exactly when a real outage gets ignored.
  //
  // NOTE (deliberate gap): there are no quiet hours. Doing that properly
  // needs a per-tenant timezone, which the tenants table doesn't have yet,
  // and guessing one would mean texting a volunteer at 3am while believing
  // it was mid-afternoon. Until a timezone exists, a 2am outage texts the
  // gate contact at 2am. See the follow-up note in NOTES-gate-pi.md.
  if (action === 'cron_check_bridges') {
    const cronSecret = Deno.env.get('CRON_SECRET');
    const got = req.headers.get('x-cron-secret');
    if (!cronSecret || got !== cronSecret) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }

    const GA = await import('../_shared/gate_alert.ts');
    const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
    const { enqueueAdminTask } = await import('../_shared/enqueue_task.ts');
    const { sendSms } = await import('../_shared/send_sms.ts');

    const PROVIDER_EMAIL = Deno.env.get('PROVIDER_NOTIFY_EMAIL') ?? 'doug@poolsideapp.com';
    const PROVIDER_PHONE = Deno.env.get('PROVIDER_NOTIFY_PHONE') ?? '';

    const now = Date.now();
    const { data: panels } = await sb.from('gate_panels')
      .select('tenant_id, status, panel_host, bridge_last_seen_at, bridge_alert_state, bridge_alert_first_offline_at, bridge_club_alerted_at, contact_phone, contact_name, bridge_flap_count, bridge_flap_window_start, bridge_flap_alerted_at, bridge_last_offline_alert_at')
      .eq('status', 'active');

    let newly_offline = 0, newly_escalated = 0, newly_recovered = 0;
    const results: Array<Record<string, unknown>> = [];

    // Notify Doug on both channels. Email is the record; SMS is the one that
    // actually wakes him up. Never throws — a notification failure must not
    // stop the loop from processing the remaining clubs.
    async function notifyProvider(args: {
      tenantId: string; subject: string; html: string; sms: string;
    }) {
      try {
        await sendEmail({ to: PROVIDER_EMAIL, subject: args.subject, html: args.html });
      } catch (e) {
        console.error('provider email (non-fatal):', (e as Error).message);
      }
      if (PROVIDER_PHONE) {
        try {
          // critical: this alert is the thing the monitoring fee buys. It
          // must not be swallowed by the platform-wide daily safety cap,
          // which exists to stop runaway roster loops, not single alerts.
          const r = await sendSms({
            sb, tenantId: args.tenantId, to: PROVIDER_PHONE, body: args.sms,
            kind: 'transactional', critical: true, source: 'gate_admin.provider_alert',
          });
          if (!r.sent) console.error('provider sms not sent:', r.error);
        } catch (e) {
          console.error('provider sms (non-fatal):', (e as Error).message);
        }
      }
    }

    for (const p of (panels ?? [])) {
      const tenantId = p.tenant_id as string;
      const lastSeenIso = p.bridge_last_seen_at as string | null;
      const state = String(p.bridge_alert_state ?? 'ok');

      // A panel that has never checked in isn't an outage, it's an install
      // that hasn't finished. That's the provider's problem to chase, not
      // something to alarm a club about.
      if (!lastSeenIso) continue;

      const lastSeen = new Date(lastSeenIso).getTime();
      const offlineMin = (now - lastSeen) / 60000;
      const isOnline = offlineMin < GA.RECOVERY_MIN;

      const { data: tenant } = await sb.from('tenants')
        .select('slug, display_name').eq('id', tenantId).maybeSingle();
      const clubName = (tenant?.display_name as string) || 'your club';
      const slug = (tenant?.slug as string) || '';

      // ── recovery: any alerted state → ok ────────────────────────────
      if (isOnline && state !== 'ok') {
        const clubWasTold = state === 'alerted_club';
        const startedAt = p.bridge_alert_first_offline_at as string | null;
        const downMin = startedAt
          ? (now - new Date(startedAt).getTime()) / 60000
          : offlineMin;

        await sb.from('gate_panels').update({
          bridge_alert_state: 'ok',
          bridge_alert_first_offline_at: null,
          bridge_club_alerted_at: null,
          bridge_outage_reply: null,
          bridge_outage_reply_at: null,
          bridge_last_alert_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId);

        // Two reasons to stay quiet: this outage was never announced (so an
        // "it's back" is describing a problem nobody knew about), or the
        // bridge is flapping and the flap alert already covers it.
        const tellProvider = GA.shouldSendRecovery({
          count: Number(p.bridge_flap_count ?? 0),
          windowStart: p.bridge_flap_window_start as string | null,
          lastOfflineAlertAt: p.bridge_last_offline_alert_at as string | null,
          outageStartedAt: startedAt,
        });
        if (tellProvider) {
          await notifyProvider({
            tenantId,
            subject: `[bridge recovered] ${clubName} after ${GA.humanDuration(downMin)}`,
            html: `<div style="font-family:Inter,Arial,sans-serif;padding:18px">
              <p><b>${escHtml(clubName)}</b> gate bridge is back online after <b>${GA.humanDuration(downMin)}</b>.</p>
              <p>${clubWasTold ? 'The club was texted during this outage, so they have had an all-clear.' : 'The club was never notified. As far as they know, nothing happened.'}</p>
            </div>`,
            sms: GA.providerRecoverySms({ clubName, downMin, clubWasTold }),
          });
        }

        // Only tell the club it's fixed if they were ever told it was
        // broken. An unprompted "all clear" for an outage nobody mentioned
        // just generates a confused reply.
        if (clubWasTold) {
          try {
            await fetch(`${SUPABASE_URL}/functions/v1/push_admin`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'authorization': `Bearer ${SERVICE_ROLE}`,
                'x-poolside-internal': SERVICE_ROLE,
              },
              body: JSON.stringify({
                action: 'send_scoped', tenant_id: tenantId, scopes: ['operations'],
                title: `Gate bridge back online at ${clubName}`,
                body: 'Phone unlock is working again. Nothing else to do.',
                url: '/club/admin/settings.html#gate',
                tag: `gate.recovery:${tenantId}`,
              }),
            });
            const { data: owners } = await sb.from('admin_users')
              .select('email').eq('tenant_id', tenantId).eq('active', true)
              .or('role_template.eq.owner,role_template.eq.gate_manager');
            const html = `
              <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px;color:#0f172a">
                <h2 style="font-family:Georgia,serif;color:#14532d;margin:0 0 12px">Gate bridge back online</h2>
                <p style="margin:0 0 8px;color:#475569;line-height:1.55">The bridge at <b>${escHtml(clubName)}</b> is checking in again, after ${escHtml(GA.humanDuration(downMin))} offline. Members can unlock the gate from their phones again.</p>
                <p style="margin:0;color:#475569;line-height:1.55">Nothing further to do. Thanks for checking on it.</p>
              </div>`;
            for (const o of (owners ?? [])) {
              if (o.email) await sendEmail({ to: o.email as string, subject: `Gate bridge back online - ${clubName}`, html });
            }
          } catch (e) {
            console.error('club recovery notify (non-fatal):', (e as Error).message);
          }
        }

        results.push({ tenant_id: tenantId, transition: 'recovered', down_min: Math.round(downMin), club_was_told: clubWasTold, provider_notified: tellProvider });
        newly_recovered++;
        continue;
      }

      // ── stage 1: ok → alerted_provider ──────────────────────────────
      // panel_host gating keeps half-configured installs quiet: without a
      // host the bridge has nothing to talk to and "offline" is expected.
      if (state === 'ok' && offlineMin >= GA.PROVIDER_ALERT_MIN && p.panel_host) {
        const nowIso = new Date().toISOString();

        // Fold this outage into the rolling flap window BEFORE deciding
        // what to send. A bridge cycling every few minutes is a different
        // problem from one that is simply down, and wants a different
        // message sent once — not the same message every cycle.
        const flap = GA.advanceFlapWindow(
          Number(p.bridge_flap_count ?? 0),
          p.bridge_flap_window_start as string | null,
          nowIso,
        );
        const decision = GA.decideOfflineAlert({
          newCount: flap.count,
          windowStart: flap.windowStart,
          lastOfflineAlertAt: p.bridge_last_offline_alert_at as string | null,
          flapAlertedAt: p.bridge_flap_alerted_at as string | null,
        });

        const patch: Record<string, unknown> = {
          bridge_alert_state: 'alerted_provider',
          bridge_alert_first_offline_at: lastSeenIso,
          bridge_provider_alerted_at: nowIso,
          bridge_last_alert_at: nowIso,
          bridge_flap_count: flap.count,
          bridge_flap_window_start: flap.windowStart,
        };
        // Only a delivered alert moves these — the cooldown and the flap
        // re-alert gap both have to measure real sends, not transitions.
        if (decision === 'normal') patch.bridge_last_offline_alert_at = nowIso;
        if (decision === 'flap')   patch.bridge_flap_alerted_at = nowIso;
        await sb.from('gate_panels').update(patch).eq('tenant_id', tenantId);

        const clubAlertInMin = Math.max(1, Math.round(GA.CLUB_ALERT_MIN - offlineMin));

        if (decision === 'normal') {
          await notifyProvider({
            tenantId,
            subject: `[bridge offline] ${clubName} - ${GA.humanDuration(offlineMin)} (club not told yet)`,
            html: `<div style="font-family:Inter,Arial,sans-serif;padding:18px">
              <p><b>${escHtml(clubName)}</b> bridge offline <b>${GA.humanDuration(offlineMin)}</b>. Last seen <code>${escHtml(lastSeenIso)}</code>.</p>
              <p><b>The club has not been notified.</b> They get an automatic text at ${GA.CLUB_ALERT_MIN} minutes, roughly ${clubAlertInMin} min from now, unless the bridge comes back first.</p>
              <p>Gate contact on file: ${escHtml(String(p.contact_name ?? 'none'))} ${escHtml(String(p.contact_phone ?? ''))}</p>
              <p><a href="https://poolsideapp.com/admin/gate-integrations.html">Open provider gate-integrations</a></p>
            </div>`,
            sms: GA.providerOutageSms({ clubName, offlineMin, clubAlertInMin }),
          });
        } else if (decision === 'flap') {
          await notifyProvider({
            tenantId,
            subject: `[bridge FLAPPING] ${clubName} - ${flap.count} outages in the last hour`,
            html: `<div style="font-family:Inter,Arial,sans-serif;padding:18px">
              <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 10px">Bridge is flapping, not just offline</h2>
              <p><b>${escHtml(clubName)}</b> has gone offline <b>${flap.count} times</b> since ${escHtml(String(flap.windowStart))}.</p>
              <p>Repeated short outages usually mean <b>failing hardware</b>, not a one-off event. In rough order of likelihood: a dying power supply, a corrupting SD card, a loose or damaged network cable, or a Pi overheating in an equipment room.</p>
              <p><b>Further offline alerts for this bridge are paused for ${Math.round(GA.FLAP_REALERT_MIN / 60)} hours</b> so this doesn't bury your inbox. The pause is not a fix — the bridge is still cycling.</p>
              <p>Gate contact on file: ${escHtml(String(p.contact_name ?? 'none'))} ${escHtml(String(p.contact_phone ?? ''))}</p>
              <p><a href="https://poolsideapp.com/admin/gate-integrations.html">Open provider gate-integrations</a></p>
            </div>`,
            sms: GA.providerFlapSms({ clubName, count: flap.count }),
          });
        }

        results.push({
          tenant_id: tenantId, transition: 'alerted_provider',
          offline_min: Math.round(offlineMin),
          flap_count: flap.count, alert: decision,
        });
        newly_offline++;
        continue;
      }

      // ── stage 2: alerted_provider → alerted_club ────────────────────
      if (state === 'alerted_provider' && offlineMin >= GA.CLUB_ALERT_MIN) {
        const startedAt = (p.bridge_alert_first_offline_at as string | null) ?? lastSeenIso;
        await sb.from('gate_panels').update({
          bridge_alert_state: 'alerted_club',
          bridge_club_alerted_at: new Date().toISOString(),
          bridge_last_alert_at: new Date().toISOString(),
        }).eq('tenant_id', tenantId);

        let smsOk = false, smsErr: string | null = null;
        // Normalise before sending: this column holds whatever the board
        // typed, and Twilio rejects anything that isn't E.164.
        const contactPhone = GA.toE164(p.contact_phone as string | null);

        try {
          // One-tap reply link, signed against this specific outage.
          const token = await GA.mintReplyToken(slug, startedAt);
          const link = GA.replyLink(slug, token);

          if (contactPhone) {
            const r = await sendSms({
              sb, tenantId, to: contactPhone,
              body: GA.clubOutageSms({ clubName, offlineMin, link }),
              kind: 'transactional', critical: true, source: 'gate_admin.outage',
            });
            smsOk = r.sent;
            smsErr = r.error ?? null;
          } else {
            smsErr = p.contact_phone
              ? `contact_phone "${p.contact_phone}" is not a usable number`
              : 'no contact_phone on file';
          }

          // Board dashboard task + push.
          await enqueueAdminTask(sb, {
            tenant_id: tenantId,
            target_scopes: ['operations'],
            kind: 'gate.bridge_offline',
            summary: `Gate bridge offline ${GA.humanDuration(offlineMin)} - key fobs still work, phone unlock is down`,
            link_url: '/club/admin/settings.html#gate',
            source_kind: 'gate_panel', source_id: tenantId,
            push_title: `Gate bridge offline at ${clubName}`,
            push_body: `${GA.FOBS_STILL_WORK} Check the bridge has power and the internet is up.`,
          });

          // Email the owners with the same three checks as the text.
          const { data: owners } = await sb.from('admin_users')
            .select('email').eq('tenant_id', tenantId).eq('active', true)
            .or('role_template.eq.owner,role_template.eq.gate_manager');
          const steps = GA.CHECK_STEPS.map(s => `<li>${escHtml(s)}</li>`).join('');
          const html = `
            <div style="font-family:Inter,Arial,sans-serif;max-width:560px;padding:24px;color:#0f172a">
              <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 12px">Gate bridge offline</h2>
              <p style="margin:0 0 14px;padding:12px 14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:14px;color:#166534"><b>${escHtml(GA.FOBS_STILL_WORK)}</b> Nobody is locked out.</p>
              <p style="margin:0 0 12px;color:#475569;line-height:1.55">The bridge for <b>${escHtml(clubName)}</b> stopped checking in <b>${escHtml(GA.humanDuration(offlineMin))}</b> ago. Until it is back, members can't open the gate from the Poolside app.</p>
              <h3 style="font-family:Georgia,serif;color:#0a3b5c;font-size:15px;margin:18px 0 6px">Three things to check</h3>
              <ol style="margin:0 0 14px;padding-left:22px;font-size:14px;line-height:1.8;color:#0f172a">${steps}</ol>
              <p style="margin:0 0 16px;font-size:13.5px;color:#475569">If none of that helps, reply to this email or tap the link in the text we sent ${escHtml(String(p.contact_name ?? 'your gate contact'))}. Doug has already been alerted and is looking at it.</p>
              <p style="margin:0;padding:12px 14px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;font-size:13px;color:#475569">You'll get an all-clear from us automatically once the bridge is back, usually within 5 minutes of it reconnecting.</p>
            </div>`;
          for (const o of (owners ?? [])) {
            if (o.email) await sendEmail({ to: o.email as string, subject: `Gate bridge offline at ${clubName} (fobs still work)`, html });
          }
        } catch (e) {
          console.error('club escalation notify (non-fatal):', (e as Error).message);
        }

        await notifyProvider({
          tenantId,
          subject: `[bridge escalated] ${clubName} - club texted at ${GA.humanDuration(offlineMin)}`,
          html: `<div style="font-family:Inter,Arial,sans-serif;padding:18px">
            <p><b>${escHtml(clubName)}</b> still offline after <b>${GA.humanDuration(offlineMin)}</b>. The gate contact has now been texted.</p>
            <p>Text to ${escHtml(contactPhone ?? 'nobody - no number on file')}: <b>${smsOk ? 'delivered' : 'NOT SENT'}</b>${smsErr ? ` (${escHtml(smsErr)})` : ''}</p>
            <p>Their one-tap reply will show up on the gate-integrations dashboard.</p>
            <p><a href="https://poolsideapp.com/admin/gate-integrations.html">Open provider gate-integrations</a></p>
          </div>`,
          sms: GA.providerEscalatedSms({ clubName, offlineMin, contactPhone }),
        });

        results.push({
          tenant_id: tenantId, transition: 'alerted_club',
          offline_min: Math.round(offlineMin), club_sms_sent: smsOk, club_sms_error: smsErr,
        });
        newly_escalated++;
      }
    }

    return jsonResponse({
      ok: true,
      checked: (panels ?? []).length,
      newly_offline, newly_escalated, newly_recovered,
      results,
    });
  }

  // ── outage_reply (public, no auth — token-gated) ────────────────────
  // The one-tap answer from the club's outage text. Deliberately open: the
  // person tapping is a volunteer standing at a pool, on a phone that is
  // not signed in to anything, during the exact moment things are going
  // wrong. Requiring a login here would mean nobody ever answers.
  //
  // The token is HMAC-signed over the club slug plus the outage start time,
  // so it can only be minted by us and only answers the outage in progress.
  // Worst case for a leaked token is a wrong hint about a power cut.
  if (action === 'outage_reply') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    const token = String(body.token ?? '');
    const reply = String(body.reply ?? '');
    if (!slug || !token) return jsonResponse({ ok: false, error: 'Missing link details' }, 400);
    if (reply && reply !== 'power_outage' && reply !== 'please_check') {
      return jsonResponse({ ok: false, error: 'Unknown reply' }, 400);
    }

    const GA = await import('../_shared/gate_alert.ts');

    const { data: tenant } = await sb.from('tenants')
      .select('id, display_name').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Link not valid' }, 404);

    const { data: panel } = await sb.from('gate_panels')
      .select('tenant_id, bridge_alert_state, bridge_alert_first_offline_at, bridge_last_seen_at, bridge_outage_reply')
      .eq('tenant_id', tenant.id as string).maybeSingle();
    if (!panel) return jsonResponse({ ok: false, error: 'Link not valid' }, 404);

    const startedAt = panel.bridge_alert_first_offline_at as string | null;
    const valid = await GA.verifyReplyToken(slug, token, startedAt);
    if (!valid) {
      // The common cause is a good link tapped after the bridge recovered,
      // which is genuinely good news — say so rather than showing an error.
      const backOnline = panel.bridge_alert_state === 'ok';
      return jsonResponse({
        ok: false, resolved: backOnline,
        club_name: tenant.display_name,
        error: backOnline
          ? 'This outage is already resolved - the bridge is back online.'
          : 'This link has expired. Please contact Poolside directly.',
      }, 200);
    }

    // The cron only runs every 5 minutes, so a bridge can be back for
    // several minutes before the state machine notices and clears the
    // outage. Someone tapping the link in that window is holding a valid
    // token for a problem that no longer exists — tell them it's fixed
    // rather than asking them to go check a bridge that is already up.
    const lastSeen = panel.bridge_last_seen_at as string | null;
    const seenMinAgo = lastSeen ? (Date.now() - new Date(lastSeen).getTime()) / 60000 : Infinity;
    if (seenMinAgo < GA.RECOVERY_MIN) {
      return jsonResponse({
        ok: false, resolved: true, club_name: tenant.display_name,
        error: 'The bridge is back online.',
      }, 200);
    }

    // GET-shaped preflight: the page asks about the outage before showing
    // buttons, so a link scanner prefetching the URL can't record an answer.
    if (!reply) {
      // Measured from when the outage started, not from the last heartbeat.
      // Same number while it is genuinely down, but it stays truthful if a
      // stray heartbeat lands mid-outage.
      const offlineMin = (Date.now() - new Date(startedAt as string).getTime()) / 60000;
      return jsonResponse({
        ok: true, club_name: tenant.display_name,
        offline_label: GA.humanDuration(offlineMin),
        fobs_note: GA.FOBS_STILL_WORK,
        steps: GA.CHECK_STEPS,
        already: panel.bridge_outage_reply ?? null,
      });
    }

    await sb.from('gate_panels').update({
      bridge_outage_reply: reply,
      bridge_outage_reply_at: new Date().toISOString(),
    }).eq('tenant_id', tenant.id as string);

    // Tell Doug what they said. This is the whole reason for the link: it
    // turns "the bridge is down" into "the bridge is down and the power is
    // out", which is the difference between driving over and waiting.
    try {
      const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
      const { sendSms } = await import('../_shared/send_sms.ts');
      const label = GA.REPLY_LABELS[reply] ?? reply;
      const clubName = String(tenant.display_name ?? 'A club');
      const PROVIDER_EMAIL = Deno.env.get('PROVIDER_NOTIFY_EMAIL') ?? 'doug@poolsideapp.com';
      const PROVIDER_PHONE = Deno.env.get('PROVIDER_NOTIFY_PHONE') ?? '';
      await sendEmail({
        to: PROVIDER_EMAIL,
        subject: `[bridge reply] ${clubName}: ${label}`,
        html: `<div style="font-family:Inter,Arial,sans-serif;padding:18px">
          <p><b>${escHtml(clubName)}</b> answered the outage text:</p>
          <p style="font-size:17px"><b>${escHtml(label)}</b></p>
          <p><a href="https://poolsideapp.com/admin/gate-integrations.html">Open provider gate-integrations</a></p>
        </div>`,
      });
      if (PROVIDER_PHONE) {
        await sendSms({
          sb, tenantId: tenant.id as string, to: PROVIDER_PHONE,
          body: `Poolside: ${clubName} replied to the gate outage text: "${label}".`,
          kind: 'transactional', critical: true, source: 'gate_admin.outage_reply',
        });
      }
    } catch (e) {
      console.error('outage reply notify (non-fatal):', (e as Error).message);
    }

    return jsonResponse({ ok: true, recorded: reply, club_name: tenant.display_name });
  }

  const payload = action.startsWith('super_')
    ? await verifyTenantAdminOrProvider(req)
    : await verifyTenantAdmin(req);
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  // ── Tenant-side actions ──────────────────────────────────────────────

  if (action === 'get_status') {
    const { data: row } = await sb.from('gate_panels')
      .select('*').eq('tenant_id', payload.tid).maybeSingle();
    return jsonResponse({
      ok: true,
      panel: publicGatePanel(row),
      bridge_health: bridgeHealth(row),
    });
  }

  if (action === 'request_addon') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can request the gate add-on' }, 403);
    }
    const panelType = String(body.panel_type ?? 'unknown');
    if (!['mengqi_hxc7000', 'unknown', 'custom'].includes(panelType)) {
      return jsonResponse({ ok: false, error: 'Invalid panel_type' }, 400);
    }
    const contactName  = String(body.contact_name  ?? '').trim();
    const contactPhone = String(body.contact_phone ?? '').trim();
    const contactEmail = String(body.contact_email ?? '').trim().toLowerCase();

    if (!contactName || !contactPhone) {
      return jsonResponse({ ok: false, error: 'Name and phone number are required so we can call you.' }, 400);
    }

    // Insert or upsert the gate_panels row at status='requested'. Contact
    // info goes into structured columns (added 2026-05-22) so Doug can see
    // it on the provider admin and call the right person without digging
    // through notes/audit logs.
    const { error } = await sb.from('gate_panels').upsert({
      tenant_id: payload.tid,
      status: 'requested',
      panel_type: panelType,
      requested_at: new Date().toISOString(),
      contact_name:  contactName,
      contact_phone: contactPhone,
      contact_email: contactEmail || null,
      notes: `Requested by ${contactName} (${contactPhone})`,
    }, { onConflict: 'tenant_id' });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Pull tenant info so the notification email + audit have the club name.
    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name').eq('id', payload.tid).maybeSingle();
    const clubName = tenant?.display_name || payload.tid;
    const clubSlug = tenant?.slug || '';

    // Notify Doug via admin_task. (Owner-scoped so it shows on the tenant's
    // own dashboard too — useful for the membership chair to know the
    // request is in flight.)
    await sb.from('admin_tasks').insert({
      tenant_id: payload.tid,
      target_scopes: [],   // owners-only by default
      kind: 'gate.addon_requested',
      summary: `Gate add-on requested (${panelType}) — Doug will call to coordinate`,
      link_url: '/club/admin/settings.html#gate',
      source_kind: 'gate_panel', source_id: payload.tid,
    });
    await sb.from('audit_log').insert({
      tenant_id: payload.tid, kind: 'gate.addon_requested',
      entity_type: 'gate_panel', entity_id: payload.tid,
      summary: `Gate add-on requested (${panelType})`,
      actor_id: payload.sub, actor_kind: 'tenant_admin',
      metadata: { panel_type: panelType, contact_name: contactName, contact_phone: contactPhone, contact_email: contactEmail },
    });

    // Email Doug so he can reach out. Best-effort — the request is recorded
    // in admin_tasks regardless, so a Resend hiccup doesn't lose the lead.
    try {
      const { sendEmail, escHtml: escapeHtml } = await import('../_shared/send_email.ts');
      const PROVIDER_EMAIL = Deno.env.get('PROVIDER_NOTIFY_EMAIL') ?? 'doug@poolsideapp.com';
      const panelLabel = ({
        mengqi_hxc7000: 'MENGQI-CONTROL HXC-7000 (verified template)',
        unknown:        'Unknown panel — needs identification',
        custom:         'Custom / unsupported panel',
      } as Record<string, string>)[panelType] ?? panelType;
      const subj = `🚪 Gate integration request: ${clubName}`;
      const html = `
        <div style="font-family:Inter,Arial,sans-serif;max-width:600px;padding:24px;color:#0f172a">
          <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 14px">🚪 New gate integration request</h2>
          <p style="margin:0 0 16px;color:#475569;line-height:1.55"><b>${escapeHtml(clubName)}</b> just requested keyfob integration. Call them to confirm the panel + integration plan. No invoice goes out until you've verified everything works.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:0 0 18px">
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Club</td><td style="padding:6px 0"><b>${escapeHtml(clubName)}</b> (${escapeHtml(clubSlug)}.poolsideapp.com)</td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Panel</td><td style="padding:6px 0">${escapeHtml(panelLabel)}</td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Contact</td><td style="padding:6px 0"><b>${escapeHtml(contactName)}</b></td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Phone</td><td style="padding:6px 0"><a href="tel:${escapeHtml(contactPhone)}">${escapeHtml(contactPhone)}</a></td></tr>
            ${contactEmail ? `<tr><td style="padding:6px 14px 6px 0;color:#64748b">Email</td><td style="padding:6px 0"><a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></td></tr>` : ''}
          </table>
          <p style="margin:16px 0 8px"><a href="https://poolsideapp.com/admin/gate-integrations.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open Gate Integrations admin →</a></p>
          <p style="margin:18px 0 0;font-size:12px;color:#94a3b8">After you've talked to them and the integration is in place, hit "💸 Send invoice" on their row to bill the setup + monthly fee.</p>
        </div>
      `;
      await sendEmail({
        to: PROVIDER_EMAIL,
        subject: subj,
        html,
        replyTo: contactEmail || undefined,
      });
    } catch (e) {
      console.error('gate.request_addon: provider email failed (non-fatal):', (e as Error).message);
    }

    return jsonResponse({
      ok: true,
      message: "Got it! Doug will call you within 1 business day to walk through your gate panel and confirm we can integrate. No invoice goes out until you've said yes after that call.",
    });
  }

  if (action === 'update_config') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can change gate config' }, 403);
    }
    const { data: row } = await sb.from('gate_panels')
      .select('id, status, config_locked').eq('tenant_id', payload.tid).maybeSingle();
    if (!row || row.status !== 'active') {
      return jsonResponse({ ok: false, error: 'Gate add-on is not active for this club' }, 400);
    }
    if (row.config_locked) {
      return jsonResponse({ ok: false, error: 'Panel configuration is locked. Click 🔓 Unlock to edit.' }, 423);
    }
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.panel_host !== undefined)            patch.panel_host = String(body.panel_host).trim() || null;
    if (body.panel_admin_user !== undefined)      patch.panel_admin_user = String(body.panel_admin_user).trim() || null;
    if (body.panel_admin_password !== undefined && String(body.panel_admin_password).trim()) {
      patch.panel_admin_password = String(body.panel_admin_password);
    }
    const { error } = await sb.from('gate_panels').update(patch).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('audit_log').insert({
      tenant_id: payload.tid, kind: 'gate.config_updated',
      entity_type: 'gate_panel', entity_id: row.id,
      summary: 'Updated panel host/credentials',
      actor_id: payload.sub, actor_kind: 'tenant_admin',
    });
    return jsonResponse({ ok: true });
  }

  if (action === 'rotate_bridge_secret') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can rotate the bridge secret' }, 403);
    }
    // Block when locked — rotating breaks the on-site bridge until someone
    // updates the .env file. Same lock that protects panel host/creds applies.
    const { data: lockCheck } = await sb.from('gate_panels')
      .select('config_locked').eq('tenant_id', payload.tid).maybeSingle();
    if (lockCheck?.config_locked) {
      return jsonResponse({ ok: false, error: 'Panel configuration is locked. Click 🔓 Unlock first — rotating the secret would break the on-site bridge until the .env is updated.' }, 423);
    }
    const secret = randomBridgeSecret();
    const hash = await sha256Hex(secret);
    const { data: row, error } = await sb.from('gate_panels')
      .update({ bridge_secret_hash: hash, updated_at: new Date().toISOString() })
      .eq('tenant_id', payload.tid)
      .select('bridge_id').maybeSingle();
    if (error || !row) return jsonResponse({ ok: false, error: error?.message || 'No gate config' }, 500);
    await sb.from('audit_log').insert({
      tenant_id: payload.tid, kind: 'gate.bridge_secret_rotated',
      entity_type: 'gate_panel', entity_id: row.bridge_id,
      summary: 'Bridge secret rotated', actor_id: payload.sub, actor_kind: 'tenant_admin',
    });
    return jsonResponse({
      ok: true,
      bridge_id: row.bridge_id,
      bridge_secret: secret,    // ONE-TIME plaintext
      message: 'Save this secret — it can\'t be recovered. Re-rotate if you lose it.',
    });
  }

  // set_config_lock — toggle the panel-config lock. When locked, panel host /
  // user / password / bridge-secret rotation are all read-only; the test
  // unlock + recent unlocks views still work, and the bridge keeps running.
  // Only owners can toggle. Audit-logged.
  if (action === 'set_config_lock') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can lock/unlock panel config' }, 403);
    }
    const wantLocked = !!body.locked;
    const patch: Record<string, unknown> = {
      config_locked: wantLocked,
      config_locked_at: wantLocked ? new Date().toISOString() : null,
      config_locked_by: wantLocked ? payload.sub : null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await sb.from('gate_panels').update(patch).eq('tenant_id', payload.tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('audit_log').insert({
      tenant_id: payload.tid,
      kind: wantLocked ? 'gate.config_locked' : 'gate.config_unlocked',
      entity_type: 'gate_panel', entity_id: payload.tid,
      summary: wantLocked ? 'Panel config locked' : 'Panel config unlocked',
      actor_id: payload.sub, actor_kind: 'tenant_admin',
    });
    return jsonResponse({ ok: true, locked: wantLocked });
  }

  if (action === 'recent_unlocks') {
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 25));
    const { data, error } = await sb.from('gate_unlocks')
      .select('id, member_id, status, requested_at, completed_at, result_code, result_detail, is_test, actor_kind')
      .eq('tenant_id', payload.tid)
      .order('requested_at', { ascending: false })
      .limit(limit);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // Resolve member names for display
    const memberIds = [...new Set((data ?? []).map(r => r.member_id).filter(Boolean))];
    const { data: members } = memberIds.length
      ? await sb.from('household_members').select('id, name').in('id', memberIds)
      : { data: [] };
    const nameById = new Map((members ?? []).map(m => [m.id, m.name]));
    return jsonResponse({
      ok: true,
      unlocks: (data ?? []).map(u => ({ ...u, member_name: nameById.get(u.member_id) ?? null })),
    });
  }

  if (action === 'test_unlock') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can fire test unlocks' }, 403);
    }
    const { data: row } = await sb.from('gate_panels')
      .select('id, status, panel_host').eq('tenant_id', payload.tid).maybeSingle();
    if (!row || row.status !== 'active') {
      return jsonResponse({ ok: false, error: 'Gate add-on is not active' }, 400);
    }
    if (!row.panel_host) {
      return jsonResponse({ ok: false, error: 'Panel host not configured yet — fill in the panel info first' }, 400);
    }
    const { data: unlock, error } = await sb.from('gate_unlocks').insert({
      tenant_id: payload.tid,
      member_id: null,
      status: 'pending',
      is_test: true,
      actor_kind: 'admin_test',
      client_user_agent: req.headers.get('user-agent')?.slice(0, 200) || null,
    }).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, unlock_id: unlock.id });
  }

  // ── Provider-side actions (super only) ────────────────────────────────

  if (action === 'super_list') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const { data, error } = await sb.from('gate_panels')
      .select('*, tenants:tenant_id (slug, display_name)')
      .order('requested_at', { ascending: false });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({
      ok: true,
      panels: (data ?? []).map(row => ({
        ...publicGatePanel(row),
        tenant_slug: (row as Record<string, unknown> & { tenants?: { slug: string; display_name: string } }).tenants?.slug,
        tenant_display_name: (row as Record<string, unknown> & { tenants?: { slug: string; display_name: string } }).tenants?.display_name,
        bridge_health: bridgeHealth(row),
      })),
    });
  }

  if (action === 'super_set_status') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const targetTenant = String(body.tenant_id ?? '').trim();
    const newStatus    = String(body.status ?? '').trim();
    const notes        = body.notes !== undefined ? String(body.notes) : undefined;
    if (!targetTenant)                                       return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    if (!['requested','invoiced','shipping','active','suspended','cancelled'].includes(newStatus)) {
      return jsonResponse({ ok: false, error: 'Invalid status' }, 400);
    }
    const patch: Record<string, unknown> = {
      status: newStatus,
      updated_at: new Date().toISOString(),
    };
    if (newStatus === 'active') patch.activated_at = new Date().toISOString();
    if (notes !== undefined)    patch.notes = notes;

    // Upsert so the provider can activate a tenant that hasn't requested
    // the add-on (e.g. Bishop Estates' grandfathered free path).
    const { error } = await sb.from('gate_panels').upsert({
      tenant_id: targetTenant,
      ...patch,
    }, { onConflict: 'tenant_id' });
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Mirror gate_panels.status into settings.value.features.gate AND
    // settings.value.features.keyfobs so the existing tenant_public +
    // member home + admin nav pick up the change. 'active' = both ON;
    // anything else = both OFF. Keyfob check-in is conceptually a
    // sub-feature of gate access — clubs without gate hardware never
    // need keyfob tracking. Done via shallow merge so we don't clobber
    // other settings keys.
    {
      const on = newStatus === 'active';
      const { data: existing } = await sb.from('settings')
        .select('value').eq('tenant_id', targetTenant).maybeSingle();
      const value = ((existing?.value as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      const features = ((value.features as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      features.gate = on;
      features.keyfobs = on;
      const merged = { ...value, features };
      if (existing) {
        await sb.from('settings').update({ value: merged }).eq('tenant_id', targetTenant);
      } else {
        await sb.from('settings').insert({ tenant_id: targetTenant, value: merged });
      }
    }

    await sb.from('audit_log').insert({
      tenant_id: targetTenant, kind: 'gate.status_changed_by_provider',
      entity_type: 'gate_panel',
      summary: `Provider set status to ${newStatus}`,
      actor_id: payload.sub, actor_kind: 'provider',
      metadata: { new_status: newStatus, notes },
    });

    // Notify the club's owner admins via email + push when the gate goes
    // active so they know they can start configuring the panel.
    if (newStatus === 'active') {
      try {
        const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
        const { data: tenant } = await sb.from('tenants')
          .select('slug, display_name').eq('id', targetTenant).maybeSingle();
        const { data: owners } = await sb.from('admin_users')
          .select('email').eq('tenant_id', targetTenant).eq('active', true)
          .or('role_template.eq.owner,role_template.eq.gate_manager');
        if (tenant && owners && owners.length) {
          const slug = tenant.slug;
          const name = tenant.display_name || slug;
          const html = `
            <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px">
              <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 12px">🚪 Your gate integration is live</h2>
              <p style="margin:0 0 12px;color:#475569;line-height:1.55">Hi — your keyfob/gate integration is now active for <b>${escHtml(name)}</b>. You can configure the panel + run a test unlock from your admin dashboard.</p>
              <p style="margin:18px 0"><a href="https://${escHtml(slug)}.poolsideapp.com/club/admin/settings.html#gate" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open gate settings →</a></p>
              <p style="margin:14px 0 0;color:#94a3b8;font-size:12px">Members with paid dues will see an "Unlock gate" button on their home page once the bridge is online.</p>
            </div>
          `;
          for (const o of owners) {
            if (o.email) await sendEmail({ to: o.email, subject: `🚪 Gate integration is live — ${name}`, html });
          }
        }
        // Phone-push too (uses the existing admin_push_subscriptions infra).
        await fetch(`${SUPABASE_URL}/functions/v1/push_admin`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'authorization': `Bearer ${SERVICE_ROLE}`,
            'x-poolside-internal': SERVICE_ROLE,
          },
          body: JSON.stringify({
            action: 'send_scoped',
            tenant_id: targetTenant,
            scopes: ['operations'],
            title: '🚪 Gate integration is live',
            body: 'Configure your panel + run a test unlock when you have a minute.',
            url: '/club/admin/settings.html#gate',
            tag: `gate.activated:${targetTenant}`,
          }),
        });
      } catch (e) { console.error('gate.active notify (non-fatal):', (e as Error).message); }
    }

    return jsonResponse({ ok: true, status: newStatus });
  }

  // ── super_send_invoice ─────────────────────────────────────────────────
  // Doug clicks "💸 Send invoice" on /admin/gate-integrations.html after
  // he's talked to the club + verified the integration is in place. This
  // sets the invoice_* columns and emails the tenant the bill — separate
  // from the status lifecycle so Doug can invoice a club that's already
  // 'active' without regressing their state. Behavior pivot from the old
  // auto-invoice-at-request flow (2026-05-22): the tenant request form
  // promises a call, not an invoice; the invoice arrives only when Doug
  // says it should.
  if (action === 'super_send_invoice') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const targetTenant = String(body.tenant_id ?? '').trim();
    const amountCents  = Number(body.amount_cents ?? 0);
    const overrideEmail = String(body.email ?? '').trim().toLowerCase();
    const note         = String(body.note ?? '').trim();
    if (!targetTenant) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return jsonResponse({ ok: false, error: 'amount_cents must be a positive integer' }, 400);
    }

    const { data: row } = await sb.from('gate_panels')
      .select('contact_name, contact_email, contact_phone')
      .eq('tenant_id', targetTenant).maybeSingle();
    if (!row) return jsonResponse({ ok: false, error: 'No gate panel for this tenant' }, 404);

    const { error } = await sb.from('gate_panels').update({
      invoice_amount_cents: amountCents,
      invoice_sent_at: new Date().toISOString(),
      invoice_paid_at: null,           // clear any prior paid mark — new bill
      invoice_note: note || null,
      updated_at: new Date().toISOString(),
    }).eq('tenant_id', targetTenant);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    // Pick the email address to send to. Override > contact_email from the
    // request form > the tenant's owner email. If nothing is set, surface
    // a clear error so Doug knows to collect one.
    let billTo = overrideEmail || (row.contact_email as string | null) || '';
    if (!billTo) {
      const { data: owner } = await sb.from('admin_users')
        .select('email').eq('tenant_id', targetTenant).eq('active', true)
        .eq('role_template', 'owner').limit(1).maybeSingle();
      if (owner?.email) billTo = owner.email;
    }

    const dollars = (amountCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name').eq('id', targetTenant).maybeSingle();
    const clubName = tenant?.display_name || 'your club';
    const slug = tenant?.slug || '';

    // Tenant-facing email. If we don't have a target address, we still
    // record the invoice + admin_task — Doug can resend from the modal.
    if (billTo) {
      try {
        const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
        const subj = `Poolside gate integration invoice — ${clubName}`;
        const html = `
          <div style="font-family:Inter,Arial,sans-serif;max-width:560px;padding:24px;color:#0f172a">
            <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 14px">💸 Invoice — gate integration</h2>
            <p style="margin:0 0 14px;color:#475569;line-height:1.55">Hi ${escHtml((row.contact_name as string) || 'there')}, here's the invoice for the keyfob/gate integration we set up for <b>${escHtml(clubName)}</b>.</p>
            <div style="padding:18px 22px;background:#f1f5f9;border:1.5px solid #cbd5e1;border-radius:12px;margin:0 0 18px">
              <div style="font-size:13px;color:#64748b;font-weight:600;letter-spacing:.04em;text-transform:uppercase">Amount due</div>
              <div style="font-size:32px;font-weight:700;color:#0a3b5c;margin:6px 0">${escHtml(dollars)}</div>
              ${note ? `<div style="font-size:13px;color:#475569;line-height:1.5;margin-top:8px;padding-top:10px;border-top:1px solid #cbd5e1">${escHtml(note)}</div>` : ''}
            </div>
            <p style="margin:0 0 12px;color:#475569;line-height:1.55">Reply to this email to confirm or ask questions. We'll send payment details (Venmo / check / wire) directly so you don't have to dig through statements later.</p>
            <p style="margin:18px 0 0;font-size:12px;color:#94a3b8">Sent by Poolside on behalf of doug@poolsideapp.com.</p>
          </div>
        `;
        await sendEmail({
          to: billTo,
          subject: subj,
          html,
          replyTo: 'doug@poolsideapp.com',
        });
      } catch (e) {
        console.error('gate.super_send_invoice email failed (non-fatal):', (e as Error).message);
      }
    }

    // In-app admin_task so the club sees a banner the next time they log in.
    await sb.from('admin_tasks').insert({
      tenant_id: targetTenant,
      target_scopes: [],
      kind: 'gate.invoice_received',
      summary: `Gate integration invoice received — ${dollars}`,
      link_url: `/club/admin/settings.html?focus=gate#gate`,
      source_kind: 'gate_panel', source_id: targetTenant,
    });
    await sb.from('audit_log').insert({
      tenant_id: targetTenant, kind: 'gate.invoice_sent',
      entity_type: 'gate_panel',
      summary: `Invoice sent: ${dollars}`,
      actor_id: payload.sub, actor_kind: 'provider',
      metadata: { amount_cents: amountCents, email: billTo, note },
    });

    return jsonResponse({ ok: true, amount_cents: amountCents, emailed_to: billTo || null });
  }

  // ── super_mark_invoice_paid ───────────────────────────────────────────
  // Doug got paid (Venmo confirmation, check cleared, etc.) → click "Mark
  // paid" on the provider admin. Recorded in audit log, no tenant email
  // (they already know they paid).
  if (action === 'super_mark_invoice_paid') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const targetTenant = String(body.tenant_id ?? '').trim();
    if (!targetTenant) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const { error } = await sb.from('gate_panels').update({
      invoice_paid_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq('tenant_id', targetTenant);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('audit_log').insert({
      tenant_id: targetTenant, kind: 'gate.invoice_marked_paid',
      entity_type: 'gate_panel',
      summary: 'Invoice marked paid',
      actor_id: payload.sub, actor_kind: 'provider',
    });
    return jsonResponse({ ok: true });
  }

  // ── Provider-side panel config ────────────────────────────────────────
  // Doug installs every gate panel himself (it's a real-world coordination
  // job — see notes near 'request_addon'). So the provider needs to do
  // EVERYTHING the tenant could do, without logging into the tenant. Each
  // action here mirrors a tenant action above but takes tenant_id in the
  // body.

  if (action === 'super_get_panel') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const tid = String(body.tenant_id ?? '').trim();
    if (!tid) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const { data: panel } = await sb.from('gate_panels')
      .select('*, tenants:tenant_id (slug, display_name)')
      .eq('tenant_id', tid).maybeSingle();
    if (!panel) return jsonResponse({ ok: false, error: 'No gate panel for this tenant' }, 404);
    return jsonResponse({
      ok: true,
      panel: {
        ...publicGatePanel(panel),
        tenant_slug: (panel as Record<string, unknown> & { tenants?: { slug: string; display_name: string } }).tenants?.slug,
        tenant_display_name: (panel as Record<string, unknown> & { tenants?: { slug: string; display_name: string } }).tenants?.display_name,
        bridge_health: bridgeHealth(panel),
      },
    });
  }

  if (action === 'super_update_config') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const tid = String(body.tenant_id ?? '').trim();
    if (!tid) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.panel_host !== undefined)        patch.panel_host = String(body.panel_host).trim() || null;
    if (body.panel_admin_user !== undefined)  patch.panel_admin_user = String(body.panel_admin_user).trim() || null;
    if (body.panel_admin_password !== undefined && String(body.panel_admin_password).trim()) {
      patch.panel_admin_password = String(body.panel_admin_password);
    }
    if (body.panel_type !== undefined) {
      const t = String(body.panel_type);
      if (['mengqi_hxc7000', 'unknown', 'custom'].includes(t)) patch.panel_type = t;
    }
    if (body.notes !== undefined) patch.notes = String(body.notes).slice(0, 4000) || null;
    const { error } = await sb.from('gate_panels').update(patch).eq('tenant_id', tid);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await sb.from('audit_log').insert({
      tenant_id: tid, kind: 'gate.config_updated_by_provider',
      entity_type: 'gate_panel',
      summary: 'Panel config updated by provider',
      actor_id: payload.sub, actor_kind: 'provider',
    });
    return jsonResponse({ ok: true });
  }

  if (action === 'super_rotate_bridge_secret') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const tid = String(body.tenant_id ?? '').trim();
    if (!tid) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const secret = randomBridgeSecret();
    const hash = await sha256Hex(secret);
    const { data: row, error } = await sb.from('gate_panels')
      .update({ bridge_secret_hash: hash, updated_at: new Date().toISOString() })
      .eq('tenant_id', tid)
      .select('bridge_id').maybeSingle();
    if (error || !row) return jsonResponse({ ok: false, error: error?.message || 'No gate config' }, 500);
    await sb.from('audit_log').insert({
      tenant_id: tid, kind: 'gate.bridge_secret_rotated_by_provider',
      entity_type: 'gate_panel', entity_id: row.bridge_id,
      summary: 'Bridge secret rotated by provider',
      actor_id: payload.sub, actor_kind: 'provider',
    });
    return jsonResponse({
      ok: true,
      bridge_id: row.bridge_id,
      bridge_secret: secret,
      message: 'One-time plaintext — copy now and paste into the on-site bridge .env file.',
    });
  }

  if (action === 'super_test_unlock') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const tid = String(body.tenant_id ?? '').trim();
    if (!tid) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const { data: row } = await sb.from('gate_panels')
      .select('id, status, panel_host').eq('tenant_id', tid).maybeSingle();
    if (!row || row.status !== 'active') {
      return jsonResponse({ ok: false, error: 'Gate add-on is not active' }, 400);
    }
    if (!row.panel_host) {
      return jsonResponse({ ok: false, error: 'Panel host not configured yet' }, 400);
    }
    const { data: unlock, error } = await sb.from('gate_unlocks').insert({
      tenant_id: tid,
      member_id: null,
      status: 'pending',
      is_test: true,
      actor_kind: 'provider_test',
      client_user_agent: req.headers.get('user-agent')?.slice(0, 200) || null,
    }).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, unlock_id: unlock.id });
  }

  if (action === 'super_recent_unlocks') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider access required' }, 403);
    }
    const tid = String(body.tenant_id ?? '').trim();
    if (!tid) return jsonResponse({ ok: false, error: 'tenant_id required' }, 400);
    const limit = Math.min(100, Math.max(1, Number(body.limit) || 25));
    const { data, error } = await sb.from('gate_unlocks')
      .select('id, member_id, status, requested_at, completed_at, result_code, result_detail, is_test, actor_kind')
      .eq('tenant_id', tid)
      .order('requested_at', { ascending: false })
      .limit(limit);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const memberIds = [...new Set((data ?? []).map(r => r.member_id).filter(Boolean))];
    const { data: members } = memberIds.length
      ? await sb.from('household_members').select('id, name').in('id', memberIds)
      : { data: [] };
    const nameById = new Map((members ?? []).map(m => [m.id, m.name]));
    return jsonResponse({
      ok: true,
      unlocks: (data ?? []).map(u => ({ ...u, member_name: nameById.get(u.member_id) ?? null })),
    });
  }

  // ── Gate integration requests ────────────────────────────────────────
  // The "tell us what you have and we'll call you" intake. Deliberately
  // separate from request_addon: that one assumes the club already knows
  // its panel matches something we support, which is the assumption this
  // whole flow exists to stop making.

  if (action === 'submit_integration_request') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can request a gate integration' }, 403);
    }

    const contactName  = String(body.contact_name  ?? '').trim();
    const contactPhone = String(body.contact_phone ?? '').trim();
    const contactEmail = String(body.contact_email ?? '').trim().toLowerCase();
    if (!contactName || !contactPhone) {
      return jsonResponse({ ok: false, error: 'We need a name and a phone number so we can call you back.' }, 400);
    }

    // Everything below is optional. A treasurer who knows nothing about the
    // panel but can photograph it is exactly who this form is for.
    const str = (v: unknown, max = 2000) => {
      const t = String(v ?? '').trim();
      return t ? t.slice(0, max) : null;
    };
    const doorCountRaw = Number(body.door_count);
    const doorCount = Number.isFinite(doorCountRaw) && doorCountRaw >= 1 && doorCountRaw <= 50
      ? Math.trunc(doorCountRaw) : null;
    const linkTypeRaw = String(body.link_type ?? '').trim();
    const linkType = ['wired', 'wifi', 'cellular', 'unknown'].includes(linkTypeRaw) ? linkTypeRaw : null;

    // Refuse early if one is already in flight, so the club gets a sentence
    // rather than a unique-violation from the index.
    const { data: existingOpen } = await sb.from('gate_integration_requests')
      .select('id, status, created_at')
      .eq('tenant_id', payload.tid)
      .in('status', ['submitted', 'reviewing', 'call_scheduled', 'quoted'])
      .maybeSingle();
    if (existingOpen) {
      return jsonResponse({
        ok: false,
        error: "You already have a gate request open — we're on it. Give us a nudge if you haven't heard back.",
        request_id: existingOpen.id,
      }, 409);
    }

    // ── photos ──
    // Same base64 path feedback uses. Capped at 8; anything larger than 8 MB
    // is almost certainly an unresized burst from a phone camera.
    const ALLOWED: Record<string, string> = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
    };
    const photos = Array.isArray(body.photos) ? body.photos.slice(0, 8) : [];
    const photoUrls: string[] = [];
    for (const raw of photos) {
      const ph = raw as { content_type?: string; data_b64?: string };
      const ct = String(ph.content_type ?? '');
      const b64 = String(ph.data_b64 ?? '');
      if (!ct || !b64) continue;
      if (!ALLOWED[ct]) {
        return jsonResponse({ ok: false, error: 'Photos must be JPG, PNG, WebP or HEIC.' }, 400);
      }
      let bytes: Uint8Array;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch {
        return jsonResponse({ ok: false, error: 'One of those photos did not upload cleanly. Try again?' }, 400);
      }
      if (bytes.byteLength > 8 * 1024 * 1024) {
        return jsonResponse({ ok: false, error: 'Each photo needs to be under 8 MB.' }, 400);
      }
      const path = `${payload.tid}/gate-requests/${crypto.randomUUID()}.${ALLOWED[ct]}`;
      const { error: upErr } = await sb.storage.from('club-assets')
        .upload(path, bytes, { contentType: ct, upsert: false });
      if (upErr) return jsonResponse({ ok: false, error: upErr.message }, 500);
      const { data: pub } = sb.storage.from('club-assets').getPublicUrl(path);
      photoUrls.push(pub.publicUrl);
    }

    const { data: row, error } = await sb.from('gate_integration_requests').insert({
      tenant_id:       payload.tid,
      contact_name:    contactName,
      contact_phone:   contactPhone,
      contact_email:   contactEmail || null,
      best_time_to_call: str(body.best_time_to_call, 200),
      manufacturer:    str(body.manufacturer, 200),
      model:           str(body.model, 200),
      door_count:      doorCount,
      link_type:       linkType,
      existing_system: str(body.existing_system),
      what_they_want:  str(body.what_they_want),
      photo_urls:      photoUrls,
      status:          'submitted',
    }).select('id').single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    const { data: tenant } = await sb.from('tenants')
      .select('slug, display_name').eq('id', payload.tid).maybeSingle();
    const clubName = tenant?.display_name || String(payload.tid);
    const clubSlug = tenant?.slug || '';

    await sb.from('admin_tasks').insert({
      tenant_id: payload.tid,
      target_scopes: [],
      kind: 'gate.integration_requested',
      summary: `Gate integration enquiry sent — Doug will look at the photos and call`,
      link_url: '/club/admin/settings.html#gate',
      source_kind: 'gate_integration_request', source_id: row.id,
    });
    await sb.from('audit_log').insert({
      tenant_id: payload.tid, kind: 'gate.integration_requested',
      entity_type: 'gate_integration_request', entity_id: row.id,
      summary: `Gate integration enquiry submitted (${photoUrls.length} photo${photoUrls.length === 1 ? '' : 's'})`,
      actor_id: payload.sub, actor_kind: 'tenant_admin',
      metadata: { manufacturer: str(body.manufacturer, 200), model: str(body.model, 200), door_count: doorCount },
    });

    // Best-effort. The row and the admin_task are already written, so a
    // Resend outage delays the lead rather than losing it.
    try {
      const { sendEmail, escHtml: esc } = await import('../_shared/send_email.ts');
      const PROVIDER_EMAIL = Deno.env.get('PROVIDER_NOTIFY_EMAIL') ?? 'doug@poolsideapp.com';
      const line = (k: string, v: string | null) => v
        ? `<tr><td style="padding:6px 14px 6px 0;color:#64748b;vertical-align:top">${esc(k)}</td><td style="padding:6px 0">${esc(v)}</td></tr>`
        : '';
      const photoHtml = photoUrls.length
        ? `<p style="margin:16px 0 6px;font-size:13px;color:#64748b">${photoUrls.length} photo${photoUrls.length === 1 ? '' : 's'}:</p>` +
          photoUrls.map(u => `<a href="${esc(u)}" style="display:inline-block;margin:0 6px 6px 0"><img src="${esc(u)}" alt="" style="width:120px;height:90px;object-fit:cover;border-radius:6px;border:1px solid #e2e8f0"></a>`).join('')
        : '<p style="margin:16px 0 0;font-size:13px;color:#94a3b8">No photos attached — worth asking for some on the call.</p>';
      await sendEmail({
        to: PROVIDER_EMAIL,
        subject: `🚪 Gate enquiry: ${clubName}`,
        replyTo: contactEmail || undefined,
        html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:600px;padding:24px;color:#0f172a">
          <h2 style="font-family:Georgia,serif;color:#0a3b5c;margin:0 0 14px">🚪 Gate integration enquiry</h2>
          <p style="margin:0 0 16px;color:#475569;line-height:1.55"><b>${esc(clubName)}</b> wants to talk about gate access. Nothing has been quoted and nothing has been promised — look at the photos, then call.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:0 0 8px">
            ${line('Club', `${clubName} (${clubSlug}.poolsideapp.com)`)}
            ${line('Contact', contactName)}
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Phone</td><td style="padding:6px 0"><a href="tel:${esc(contactPhone)}">${esc(contactPhone)}</a></td></tr>
            ${line('Best time', str(body.best_time_to_call, 200))}
            ${line('Manufacturer', str(body.manufacturer, 200))}
            ${line('Model', str(body.model, 200))}
            ${line('Doors', doorCount ? String(doorCount) : null)}
            ${line('Connection', linkType)}
            ${line('What they have', str(body.existing_system))}
            ${line('What they want', str(body.what_they_want))}
          </table>
          ${photoHtml}
          <p style="margin:20px 0 8px"><a href="https://poolsideapp.com/admin/gate-integrations.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open the review queue →</a></p>
        </div>`,
      });
    } catch (e) {
      console.error('gate.submit_integration_request: provider email failed (non-fatal):', (e as Error).message);
    }

    return jsonResponse({
      ok: true,
      request_id: row.id,
      message: "Thanks — that's enough to go on. Doug will look at what you've sent and call you within a couple of business days. Nothing is quoted and nothing is owed until after that conversation.",
    });
  }

  if (action === 'my_integration_request') {
    const { data } = await sb.from('gate_integration_requests')
      .select('id, status, manufacturer, model, door_count, link_type, photo_urls, quoted_setup_cents, quoted_monthly_cents, created_at, reviewed_at, decided_at')
      .eq('tenant_id', payload.tid)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    return jsonResponse({ ok: true, request: data ?? null });
  }

  if (action === 'withdraw_integration_request') {
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can withdraw a gate request' }, 403);
    }
    const { error } = await sb.from('gate_integration_requests')
      .update({ status: 'withdrawn', decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('tenant_id', payload.tid)
      .in('status', ['submitted', 'reviewing', 'call_scheduled', 'quoted']);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  if (action === 'super_list_integration_requests') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider only' }, 403);
    }
    const wanted = String(body.status ?? '').trim();
    let q = sb.from('gate_integration_requests').select('*').order('created_at', { ascending: false }).limit(200);
    if (wanted && wanted !== 'all') q = q.eq('status', wanted);
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);

    type ClubRef = { id: string; slug: string; display_name: string };
    const ids = [...new Set((data ?? []).map(r => r.tenant_id))];
    const { data: tenants } = ids.length
      ? await sb.from('tenants').select('id, slug, display_name').in('id', ids)
      : { data: [] as ClubRef[] };
    const byId = new Map<string, ClubRef>(
      ((tenants ?? []) as ClubRef[]).map(t => [t.id, t]),
    );
    return jsonResponse({
      ok: true,
      requests: (data ?? []).map(r => ({
        ...r,
        club_name: byId.get(r.tenant_id)?.display_name ?? null,
        club_slug: byId.get(r.tenant_id)?.slug ?? null,
      })),
    });
  }

  if (action === 'super_review_integration_request') {
    if (!(await requireSuper(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Provider only' }, 403);
    }
    const id = String(body.request_id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'request_id required' }, 400);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.status !== undefined) {
      const st = String(body.status);
      if (!['submitted', 'reviewing', 'call_scheduled', 'quoted', 'accepted', 'declined', 'withdrawn'].includes(st)) {
        return jsonResponse({ ok: false, error: 'Unknown status' }, 400);
      }
      patch.status = st;
      if (st === 'reviewing' || st === 'call_scheduled') patch.reviewed_at = new Date().toISOString();
      if (['accepted', 'declined', 'withdrawn'].includes(st)) patch.decided_at = new Date().toISOString();
    }
    if (body.admin_notes !== undefined) patch.admin_notes = String(body.admin_notes ?? '').slice(0, 4000) || null;
    for (const k of ['quoted_setup_cents', 'quoted_monthly_cents']) {
      if (body[k] !== undefined) {
        const n = Number(body[k]);
        patch[k] = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
      }
    }

    const { data, error } = await sb.from('gate_integration_requests')
      .update(patch).eq('id', id).select('*').maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true, request: data });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

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
  // Runs every 5 minutes via pg_cron. Detects newly-offline and newly-
  // recovered bridges across all active panels and notifies the affected
  // clubs (admin_task + push + email) plus the provider. State machine
  // on gate_panels.bridge_alert_state ensures we don't alert twice for
  // the same outage.
  if (action === 'cron_check_bridges') {
    const cronSecret = Deno.env.get('CRON_SECRET');
    const got = req.headers.get('x-cron-secret');
    if (!cronSecret || got !== cronSecret) {
      return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    }

    const OFFLINE_THRESHOLD_MS = 10 * 60 * 1000;  // 10 minutes
    const ONLINE_THRESHOLD_MS  = 2 * 60 * 1000;   //  2 minutes (recovery)
    const now = Date.now();
    const offlineCutoff = new Date(now - OFFLINE_THRESHOLD_MS).toISOString();

    const { data: panels } = await sb.from('gate_panels')
      .select('tenant_id, status, bridge_last_seen_at, bridge_alert_state, bridge_alert_first_offline_at, panel_host')
      .eq('status', 'active');

    let newly_offline = 0;
    let newly_recovered = 0;
    const results: Array<{ tenant_id: string; transition: string; ago_min?: number }> = [];

    for (const p of (panels ?? [])) {
      const lastSeen = p.bridge_last_seen_at ? new Date(p.bridge_last_seen_at as string).getTime() : 0;
      const isOffline = !lastSeen || (now - lastSeen) > OFFLINE_THRESHOLD_MS;
      const isOnline  = !!lastSeen && (now - lastSeen) < ONLINE_THRESHOLD_MS;
      const wasAlerted = p.bridge_alert_state === 'alerted_offline';

      // ── ok → alerted_offline ────────────────────────────────────────
      if (isOffline && !wasAlerted && p.panel_host) {
        // Skip never-seen-yet panels (panel_host gating filters new
        // installs that haven't even checked in once — those are the
        // provider's problem, not the club's, until first contact).
        const firstSeen = p.bridge_last_seen_at ?? null;
        if (!firstSeen) continue;

        const agoMin = Math.floor((now - lastSeen) / 60000);
        await sb.from('gate_panels').update({
          bridge_alert_state: 'alerted_offline',
          bridge_alert_first_offline_at: firstSeen,
          bridge_last_alert_at: new Date().toISOString(),
        }).eq('tenant_id', p.tenant_id);

        // Notify the club + the provider.
        try {
          const { data: tenant } = await sb.from('tenants')
            .select('slug, display_name').eq('id', p.tenant_id).maybeSingle();
          const clubName = tenant?.display_name || 'your club';

          // 1) Admin task + push (board-side ops scope)
          const { enqueueAdminTask } = await import('../_shared/enqueue_task.ts');
          await enqueueAdminTask(sb, {
            tenant_id: p.tenant_id,
            target_scopes: ['operations'],
            kind: 'gate.bridge_offline',
            summary: `🚪 Gate bridge offline (${agoMin} min) — try the troubleshooting steps in Settings`,
            link_url: '/club/admin/settings.html#gate',
            source_kind: 'gate_panel', source_id: p.tenant_id,
            push_title: `🔴 Gate bridge offline at ${clubName}`,
            push_body: `Last seen ${agoMin} min ago. Open Settings → Remote keyfob access for the 3-step fix (Pi power, internet, reboot).`,
          });

          // 2) Email club owner admins with the troubleshooting steps
          const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
          const { data: owners } = await sb.from('admin_users')
            .select('email')
            .eq('tenant_id', p.tenant_id).eq('active', true)
            .or('role_template.eq.owner,role_template.eq.gate_manager');
          const html = `
            <div style="font-family:Inter,Arial,sans-serif;max-width:560px;padding:24px;color:#0f172a">
              <h2 style="font-family:Georgia,serif;color:#7f1d1d;margin:0 0 12px">🔴 Gate bridge offline</h2>
              <p style="margin:0 0 12px;color:#475569;line-height:1.55">The on-site Pi bridge for <b>${escHtml(clubName)}</b> stopped checking in <b>${agoMin} minutes ago</b>. Members can't unlock the gate from their phones until it's back online.</p>
              <h3 style="font-family:Georgia,serif;color:#0a3b5c;font-size:15px;margin:18px 0 6px">Try these in order — most issues fix in 2 minutes:</h3>
              <ol style="margin:0 0 14px;padding-left:22px;font-size:14px;line-height:1.8;color:#0f172a">
                <li><b>Check the Pi's power LED.</b> It should be solid green. If it's off or red, plug the power back in.</li>
                <li><b>Check the club's internet.</b> Open any website on a phone connected to the club Wi-Fi. If it doesn't load, restart the club's router.</li>
                <li><b>Reboot the Pi.</b> Unplug the power for <b>10 seconds</b>, plug back in, then wait <b>60 seconds</b>. The bridge phones home automatically once the network is up.</li>
              </ol>
              <p style="margin:0 0 16px;padding:12px 14px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;font-size:13px;color:#166534">If the bridge comes back online during your troubleshooting, you'll get an "all clear" email from us within ~5 minutes — no need to do anything else.</p>
              <p style="margin:14px 0 0;font-size:13.5px;color:#475569">Tried all three and still offline? Email <a href="mailto:doug@poolsideapp.com?subject=Gate%20bridge%20still%20offline">doug@poolsideapp.com</a> with: club name, when it went down, and what you tried.</p>
            </div>
          `;
          for (const o of (owners ?? [])) {
            if (o.email) await sendEmail({ to: o.email, subject: `🔴 Gate bridge offline at ${clubName}`, html });
          }

          // 3) Provider email — short, actionable.
          const PROVIDER_EMAIL = Deno.env.get('PROVIDER_NOTIFY_EMAIL') ?? 'doug@poolsideapp.com';
          await sendEmail({
            to: PROVIDER_EMAIL,
            subject: `[bridge offline] ${clubName} — ${agoMin} min`,
            html: `
              <div style="font-family:Inter,Arial,sans-serif;padding:18px">
                <p><b>${escHtml(clubName)}</b> bridge offline ${agoMin} min. Last seen <code>${escHtml(p.bridge_last_seen_at as string)}</code>.</p>
                <p>Owner admins were notified with the 3-step troubleshooting email. Watch for a recovery alert; if none in ~30 min, follow up.</p>
                <p><a href="https://poolsideapp.com/admin/gate-integrations.html">Open provider gate-integrations →</a></p>
              </div>
            `,
          });
        } catch (e) {
          console.error('bridge offline notify (non-fatal):', (e as Error).message);
        }

        results.push({ tenant_id: p.tenant_id, transition: 'offline', ago_min: agoMin });
        newly_offline++;
        continue;
      }

      // ── alerted_offline → ok ────────────────────────────────────────
      if (isOnline && wasAlerted) {
        await sb.from('gate_panels').update({
          bridge_alert_state: 'ok',
          bridge_alert_first_offline_at: null,
          bridge_last_alert_at: new Date().toISOString(),
        }).eq('tenant_id', p.tenant_id);

        try {
          const { data: tenant } = await sb.from('tenants')
            .select('slug, display_name').eq('id', p.tenant_id).maybeSingle();
          const clubName = tenant?.display_name || 'your club';

          // Push to admins (cheap; just reassurance)
          await fetch(`${SUPABASE_URL}/functions/v1/push_admin`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'authorization': `Bearer ${SERVICE_ROLE}`,
              'x-poolside-internal': SERVICE_ROLE,
            },
            body: JSON.stringify({
              action: 'send_scoped',
              tenant_id: p.tenant_id,
              scopes: ['operations'],
              title: `✓ Gate bridge back online at ${clubName}`,
              body: 'Members can unlock the gate again. Whatever you did, it worked.',
              url: '/club/admin/settings.html#gate',
              tag: `gate.recovery:${p.tenant_id}`,
            }),
          });

          // Brief email — reassuring, no action needed
          const { sendEmail, escHtml } = await import('../_shared/send_email.ts');
          const { data: owners } = await sb.from('admin_users')
            .select('email')
            .eq('tenant_id', p.tenant_id).eq('active', true)
            .or('role_template.eq.owner,role_template.eq.gate_manager');
          const html = `
            <div style="font-family:Inter,Arial,sans-serif;max-width:520px;padding:24px;color:#0f172a">
              <h2 style="font-family:Georgia,serif;color:#14532d;margin:0 0 12px">✓ Gate bridge back online</h2>
              <p style="margin:0 0 8px;color:#475569;line-height:1.55">The bridge at <b>${escHtml(clubName)}</b> is checking in again. Members can unlock the gate from their phones. No further action needed.</p>
            </div>
          `;
          for (const o of (owners ?? [])) {
            if (o.email) await sendEmail({ to: o.email, subject: `✓ Gate bridge back online — ${clubName}`, html });
          }
        } catch (e) {
          console.error('bridge recovery notify (non-fatal):', (e as Error).message);
        }

        results.push({ tenant_id: p.tenant_id, transition: 'recovered' });
        newly_recovered++;
      }
    }

    return jsonResponse({
      ok: true,
      checked: (panels ?? []).length,
      newly_offline,
      newly_recovered,
      results,
    });
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

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// =============================================================================
// gate_admin — tenant-side + provider-side management of the gate add-on
// =============================================================================
// Tenant admin actions (require tenant_admin JWT, owner-only):
//   { action: 'get_status' }
//     → returns the tenant's gate_panels row (no secrets) + bridge_health
//   { action: 'request_addon', panel_type, contact_name, contact_email }
//     → creates a 'requested' row + admin_task for super-admin Doug
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
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifyTenantAdmin, verifyTenantAdminOrProvider, requireOwner, requireSuper } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
    const contactName  = String(body.contact_name ?? '').trim();
    const contactEmail = String(body.contact_email ?? '').trim().toLowerCase();

    // Insert or upsert the gate_panels row at status='requested'.
    const { error } = await sb.from('gate_panels').upsert({
      tenant_id: payload.tid,
      status: 'requested',
      panel_type: panelType,
      requested_at: new Date().toISOString(),
      notes: `Requested by ${contactName || payload.sub} (${contactEmail || 'no email'})`,
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
      summary: `Gate add-on requested (${panelType}) — invoice + ship bridge`,
      link_url: '/club/admin/settings.html#gate',
      source_kind: 'gate_panel', source_id: payload.tid,
    });
    await sb.from('audit_log').insert({
      tenant_id: payload.tid, kind: 'gate.addon_requested',
      entity_type: 'gate_panel', entity_id: payload.tid,
      summary: `Gate add-on requested (${panelType})`,
      actor_id: payload.sub, actor_kind: 'tenant_admin',
      metadata: { panel_type: panelType, contact_name: contactName, contact_email: contactEmail },
    });

    // Email Doug so he can reach out + invoice. Best-effort — the request
    // is recorded in admin_tasks regardless, so a Resend hiccup doesn't
    // lose the lead.
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
          <p style="margin:0 0 16px;color:#475569;line-height:1.55"><b>${escapeHtml(clubName)}</b> just requested keyfob integration. Reach out to coordinate hardware + on-site testing.</p>
          <table style="border-collapse:collapse;font-size:14px;margin:0 0 18px">
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Club</td><td style="padding:6px 0"><b>${escapeHtml(clubName)}</b> (${escapeHtml(clubSlug)}.poolsideapp.com)</td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Panel</td><td style="padding:6px 0">${escapeHtml(panelLabel)}</td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Contact</td><td style="padding:6px 0">${escapeHtml(contactName || '(not given)')}</td></tr>
            <tr><td style="padding:6px 14px 6px 0;color:#64748b">Email</td><td style="padding:6px 0">${contactEmail ? `<a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a>` : '(not given)'}</td></tr>
          </table>
          <p style="margin:16px 0 8px"><a href="https://poolsideapp.com/admin/gate-integrations.html" style="background:#0a3b5c;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;display:inline-block">Open Gate Integrations admin →</a></p>
          <p style="margin:18px 0 0;font-size:12px;color:#94a3b8">Once you've talked to them and verified payment, flip their gate panel status to <b>active</b> on the provider admin page. That auto-enables the gate features for their club.</p>
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
      message: panelType === 'mengqi_hxc7000'
        ? "Got it! We'll email you within 1 business day with an invoice. Once paid, your bridge ships in ~5 business days."
        : "Got it! We'll review your panel info and email you within 2 business days about whether we can support it + pricing.",
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

    // Mirror the gate_panels.status into settings.value.features.gate so
    // the existing tenant_public + member home + admin nav pick up the
    // change. 'active' = gate features ON; anything else = OFF. Done via
    // shallow merge so we don't clobber other settings keys.
    {
      const featureGateOn = newStatus === 'active';
      const { data: existing } = await sb.from('settings')
        .select('value').eq('tenant_id', targetTenant).maybeSingle();
      const value = ((existing?.value as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      const features = ((value.features as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
      features.gate = featureGateOn;
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

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

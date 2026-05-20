// =============================================================================
// tenant_settings — Read/write the per-tenant settings JSONB
// =============================================================================
// Auth: tenant admin token (HS256, kind='tenant_admin'). Tenant scope is
// pulled from the token, never the body, so an admin can't write to another
// tenant's settings.
//
// Actions:
//
//   { action: 'get' }
//     → { ok, settings, tenant: { display_name, slug } }
//
//   { action: 'save', value, display_name? }
//     • value: JSON object (replaces settings.value)
//     • display_name: if provided, also updates tenants.display_name
//     → { ok }
//
//   { action: 'mark_wizard_complete' }
//     → { ok }   // shorthand for save with setup_wizard_complete=true
//
//   { action: 'setup_status' }
//     → { ok, percent, done, total, items: [{ id, label, done, fix_url, fix_label, optional }] }
//     Checklist for the persistent "Club not fully set up" banner +
//     the /club/admin/setup.html step-by-step page.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { requireOwner } from '../_shared/auth.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

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

type Payload = { sub: string; kind: string; tid: string; slug: string };

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = token ? await verifyTenantAdmin(token) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── get ────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const [{ data: settings }, { data: tenant }] = await Promise.all([
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
      sb.from('tenants').select('slug, display_name, status, plan').eq('id', payload.tid).maybeSingle(),
    ]);
    return jsonResponse({
      ok: true,
      settings: settings?.value ?? {},
      tenant: tenant ?? null,
    });
  }

  // ── save ───────────────────────────────────────────────────────────────
  if (action === 'save') {
    // OWNER ONLY: settings include payment config, branding, tier prices —
    // any tenant_admin shouldn't be able to silently rewrite these.
    if (!(await requireOwner(sb, payload as never))) {
      return jsonResponse({ ok: false, error: 'Only owners can change club settings' }, 403);
    }
    const value = (body.value ?? {}) as Record<string, unknown>;
    if (typeof value !== 'object' || Array.isArray(value)) {
      return jsonResponse({ ok: false, error: '`value` must be a JSON object' }, 400);
    }

    // Upsert settings row. Shallow-merge with existing so a save from one
    // surface (wizard, settings page, members→tiers) doesn't clobber keys
    // managed by another. Top-level keys present in `value` win; any keys
    // only in the existing row (e.g. membership_tiers seeded at signup, or
    // saved from a different page) are preserved.
    const { data: existing } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    if (existing) {
      const merged = { ...(existing.value ?? {}), ...value } as Record<string, unknown>;
      const { error } = await sb.from('settings')
        .update({ value: merged }).eq('tenant_id', payload.tid);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    } else {
      const { error } = await sb.from('settings')
        .insert({ tenant_id: payload.tid, value });
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    }

    // Optionally update the tenant display_name in lockstep with the wizard.
    if (typeof body.display_name === 'string') {
      const dn = body.display_name.trim();
      if (dn) {
        await sb.from('tenants').update({ display_name: dn }).eq('id', payload.tid);
      }
    }

    return jsonResponse({ ok: true });
  }

  // ── mark_wizard_complete ───────────────────────────────────────────────
  if (action === 'mark_wizard_complete') {
    const { data: existing } = await sb.from('settings')
      .select('value').eq('tenant_id', payload.tid).maybeSingle();
    const value = { ...(existing?.value ?? {}), setup_wizard_complete: true };
    if (existing) {
      await sb.from('settings').update({ value }).eq('tenant_id', payload.tid);
    } else {
      await sb.from('settings').insert({ tenant_id: payload.tid, value });
    }
    return jsonResponse({ ok: true });
  }

  // ── setup_status ───────────────────────────────────────────────────────
  // Returns the onboarding checklist for the banner + setup page. Read-only
  // so any tenant_admin can fetch (no requireOwner gate). Items are the
  // bare minimum to launch — not the exhaustive ops health (admin_health
  // covers that).
  if (action === 'setup_status') {
    const [tenantRes, settingsRes, policyRes, ownerRes, gateRes] = await Promise.all([
      sb.from('tenants').select('display_name, slug, stripe_account_id, stripe_charges_enabled')
        .eq('id', payload.tid).maybeSingle(),
      sb.from('settings').select('value').eq('tenant_id', payload.tid).maybeSingle(),
      sb.from('policies').select('id', { count: 'exact', head: true })
        .eq('tenant_id', payload.tid).eq('active', true),
      sb.from('admin_users').select('id', { count: 'exact', head: true })
        .eq('tenant_id', payload.tid).eq('active', true),
      sb.from('gate_panels').select('status').eq('tenant_id', payload.tid).maybeSingle(),
    ]);

    const tenant = (tenantRes.data || {}) as Record<string, unknown>;
    const sv = ((settingsRes.data?.value as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    const branding = (sv.branding as Record<string, unknown> | undefined) ?? {};
    const hero = (sv.hero as Record<string, unknown> | undefined) ?? {};
    const pool = (sv.pool as Record<string, unknown> | undefined) ?? {};
    const club = (sv.club as Record<string, unknown> | undefined) ?? {};
    const payments = (sv.payments as Record<string, unknown> | undefined) ?? {};
    const tiers = (sv.membership_tiers as Array<unknown> | undefined) ?? [];
    const policyCount = policyRes.count ?? 0;
    const adminCount = ownerRes.count ?? 0;

    const stripeConnected = !!(tenant.stripe_account_id && tenant.stripe_charges_enabled);
    const venmoSet = !!(payments.venmo_handle && String(payments.venmo_handle).trim());
    const gateStatus = (gateRes.data as { status?: string } | null)?.status ?? null;
    const gateActive = gateStatus === 'active';
    const gateRequested = !!gateStatus && gateStatus !== 'active';

    // Each fix_url ends with `?focus=<id>` so the destination page can
    // scroll-to + pulse the matching field via /js/focus-highlight.js.
    // Pages annotate target nodes with data-focus="<id>" or supply a
    // FOCUS_FALLBACKS map.
    const items = [
      {
        id: 'wizard',
        label: 'Run the setup wizard',
        done: !!sv.setup_wizard_complete,
        fix_url: '/club/wizard.html',
        fix_label: 'Open wizard',
        why: 'Sets your club name, hero text, hours, and basic features in one shot.',
      },
      {
        id: 'logo',
        label: 'Upload your club logo',
        done: !!(branding.logo_url || branding.logo),
        fix_url: '/club/admin/settings.html?focus=logo',
        fix_label: 'Upload logo',
        why: 'Replaces the placeholder dot in your header and emails.',
      },
      {
        id: 'hero',
        label: 'Write your home-page headline',
        done: !!(hero.headline && String(hero.headline).trim()),
        fix_url: '/club/wizard.html',
        fix_label: 'Edit headline',
        why: 'The big line at the top of your public site.',
      },
      {
        id: 'location',
        label: 'Set your pool location and hours',
        done: !!((club.location || (pool.lat && pool.lng)) && pool.opens_at && pool.closes_at),
        fix_url: '/club/wizard.html',
        fix_label: 'Set location',
        why: 'Powers the weather ticker and stops gate unlocks outside hours.',
      },
      {
        id: 'tiers',
        label: 'Set up at least one membership tier',
        done: tiers.length > 0,
        fix_url: '/club/admin/members.html?focus=tiers#tiers',
        fix_label: 'Add a tier',
        why: 'Without tiers, your apply form is broken.',
      },
      {
        id: 'policies',
        label: 'Add policies (waiver, rules)',
        done: policyCount > 0,
        fix_url: '/club/admin/policies.html?focus=policies',
        fix_label: 'Edit policies',
        why: 'Liability protection — applicants must agree before submitting.',
      },
      // REQUIRED: at least one payment method. Done if either Stripe or
      // Venmo is fully set up. Stripe-specific status lives below as a
      // separate optional item so the user sees the truth: "Venmo is set"
      // is NOT the same as "Stripe is connected."
      {
        id: 'payment',
        label: (stripeConnected || venmoSet)
          ? 'Payment method set up'
          : 'Set up a way for members to pay',
        done: stripeConnected || venmoSet,
        fix_url: '/club/admin/payments.html?focus=venmo',
        fix_label: (stripeConnected || venmoSet) ? 'Manage payments' : 'Set up payments',
        why: stripeConnected && venmoSet
          ? 'Both Stripe (cards) and Venmo are configured — members can pick either.'
          : stripeConnected
            ? 'Stripe is connected. Adding Venmo too is optional but most clubs offer both.'
            : venmoSet
              ? 'Venmo is set. Stripe (cards) is below — optional but recommended.'
              : 'Pick at least one — Stripe (cards, ~3% fee) or Venmo (free, manual).',
      },
      // OPTIONAL: Stripe-specific. Distinct from the payment item above so
      // a club with only Venmo doesn't see "Stripe connected." If the
      // tenants table says charges_enabled but the account isn't actually
      // ready (Stripe sometimes lags by a webhook tick), the payments page
      // will surface that on next visit.
      {
        id: 'stripe',
        label: stripeConnected
          ? 'Stripe connected — cards work'
          : 'Connect Stripe (accept credit cards)',
        done: stripeConnected,
        fix_url: '/club/admin/payments.html?focus=stripe',
        fix_label: stripeConnected ? 'Stripe dashboard' : 'Connect Stripe',
        why: stripeConnected
          ? 'Members can pay dues, programs, and donations with their card.'
          : 'Cards = auto-pay, payment plans, no chasing members. ~3% fee. About 5 minutes to onboard via Stripe.',
        optional: true,
      },
      {
        id: 'admins',
        label: 'Invite a backup admin',
        done: adminCount >= 2,
        fix_url: '/club/admin/admins.html?focus=invite',
        fix_label: 'Invite admin',
        why: 'If you lose access, no one else can manage the club.',
        optional: true,
      },
      {
        id: 'gate',
        label: gateActive
          ? 'Keyfob/gate integration is active'
          : (gateRequested
              ? 'Keyfob/gate request in progress — we\'ll be in touch'
              : 'Want gate access from members\' phones?'),
        done: gateActive || gateRequested,
        fix_url: '/club/admin/settings.html?focus=gate#gate',
        fix_label: gateActive ? 'Configure panel' : (gateRequested ? 'View status' : 'Request keyfob integration'),
        why: gateActive
          ? 'Members with paid dues see the "Unlock gate" button on their home.'
          : (gateRequested
              ? 'Once we\'ve coordinated hardware + verified payment, we activate this for your club.'
              : 'Paid add-on ($250 + $25/mo). We coordinate manually — request it and we\'ll reach out.'),
        optional: true,
      },
    ];

    const required = items.filter(i => !i.optional);
    const doneCount = required.filter(i => i.done).length;
    const total = required.length;
    const percent = Math.round((doneCount / total) * 100);

    return jsonResponse({
      ok: true,
      percent,
      done: doneCount,
      total,
      complete: doneCount === total,
      items,
    });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

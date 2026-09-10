// =============================================================================
// provider_metrics — Network-wide stats for the platform owner
// =============================================================================
// Auth: provider admin (HS256, kind='provider'). Aggregates counts across
// every tenant for the provider analytics dashboard.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

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

async function verifyProviderToken(token: string): Promise<string | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const payload = await verify(token, key) as { sub?: string; kind?: string };
    if (payload.kind !== 'provider' || !payload.sub) return null;
    return payload.sub;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const token = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const adminId = token ? await verifyProviderToken(token) : null;
  if (!adminId) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // Confirm the provider admin still exists + active
  const { data: caller } = await sb.from('provider_admins')
    .select('id, active').eq('id', adminId).maybeSingle();
  if (!caller || !caller.active) {
    return jsonResponse({ ok: false, error: 'Provider admin not found or inactive' }, 401);
  }

  // ── revenue ────────────────────────────────────────────────────────────
  // What we have ACTUALLY earned, per club, per kind.
  //
  // Stripe is the source of truth and our own tables deliberately are not.
  // We record an application_fee_amount when a Checkout Session is created,
  // which is an intention, not an outcome: the member may abandon the page,
  // the card may decline, the charge may be refunded weeks later, or a
  // dispute may claw the fee back. Every one of those makes our number too
  // high and none of them raise an error. An Application Fee object, by
  // contrast, is Stripe's record of money that reached the platform balance.
  //
  // Attribution is by `account` — the connected account the charge sat on —
  // rather than by metadata, because that is Stripe's own record and holds
  // even for charges created before we started tagging them.
  //
  // Categorisation does depend on metadata, and only charges created after
  // 2026-09-09 carry it: before that, `kind` went on the Checkout Session,
  // which never propagates to the Charge. Those land in `uncategorized`
  // rather than being silently folded into dues.
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* metrics takes no body */ }
  if (String(body.action ?? '') === 'revenue') {
    const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY');
    if (!STRIPE_KEY) {
      return jsonResponse({ ok: true, configured: false, reason: 'STRIPE_SECRET_KEY is not set' });
    }
    const days = Math.min(1095, Math.max(1, Number(body.days ?? 365)));
    const since = Math.floor((Date.now() - days * 86400_000) / 1000);

    const { attributeFee, emptyBuckets } = await import('../_shared/fee_attribution.ts');
    const blank = emptyBuckets;

    const { data: tenantRows } = await sb.from('tenants')
      .select('id, slug, display_name, stripe_account_id, platform_fees_waived');
    const byAccount = new Map<string, Record<string, unknown>>();
    for (const t of (tenantRows ?? [])) {
      if (t.stripe_account_id) byAccount.set(String(t.stripe_account_id), t);
    }

    const perTenant = new Map<string, { tenant: Record<string, unknown>; buckets: ReturnType<typeof blank>; gross: number; refunded: number; count: number }>();
    const network = { buckets: blank(), gross: 0, refunded: 0, count: 0, unmatched_accounts: new Set<string>() };

    let starting_after: string | null = null;
    let pages = 0;
    const MAX_PAGES = 40;   // 4,000 fees — well past anything this platform will see for years
    try {
      while (pages < MAX_PAGES) {
        pages++;
        const qs = new URLSearchParams({ limit: '100', 'created[gte]': String(since) });
        qs.append('expand[]', 'data.charge');
        if (starting_after) qs.append('starting_after', starting_after);

        const res = await fetch(`https://api.stripe.com/v1/application_fees?${qs}`, {
          headers: { Authorization: `Bearer ${STRIPE_KEY}` },
        });
        const page = await res.json();
        if (!res.ok) {
          return jsonResponse({ ok: false, error: page?.error?.message || `Stripe ${res.status}` }, 502);
        }
        for (const fee of (page.data ?? [])) {
          // All the arithmetic lives in _shared/fee_attribution.ts so it can
          // be tested without Stripe — see scripts/fees_test.mjs.
          const at = attributeFee(fee);

          const t = at.account ? byAccount.get(at.account) : undefined;
          if (!t) { if (at.account) network.unmatched_accounts.add(at.account); }
          else {
            const key = String(t.id);
            if (!perTenant.has(key)) perTenant.set(key, { tenant: t, buckets: blank(), gross: 0, refunded: 0, count: 0 });
            const row = perTenant.get(key)!;
            row.buckets[at.bucket] += at.bucketCents;
            row.buckets.plan_fees += at.planFeeCents;
            row.gross += at.grossCents; row.refunded += at.refundedCents; row.count++;
          }
          network.buckets[at.bucket] += at.bucketCents;
          network.buckets.plan_fees += at.planFeeCents;
          network.gross += at.grossCents; network.refunded += at.refundedCents; network.count++;
        }
        if (!page.has_more) break;
        starting_after = String(page.data[page.data.length - 1]?.id ?? '');
        if (!starting_after) break;
      }
    } catch (e) {
      return jsonResponse({ ok: false, error: `Could not reach Stripe: ${(e as Error).message}` }, 502);
    }

    const clubs = [...perTenant.values()].map(r => ({
      tenant_id:    r.tenant.id,
      slug:         r.tenant.slug,
      display_name: r.tenant.display_name,
      fees_waived:  !!r.tenant.platform_fees_waived,
      charges:      r.count,
      gross_cents:    r.gross,
      refunded_cents: r.refunded,
      net_cents:      Math.max(0, r.gross - r.refunded),
      buckets:      r.buckets,
    })).sort((a, b) => b.net_cents - a.net_cents);

    // Clubs with Stripe connected that have produced nothing yet still belong
    // in the list at zero — an empty row is information, an absent one is not.
    for (const t of (tenantRows ?? [])) {
      if (t.stripe_account_id && !perTenant.has(String(t.id))) {
        clubs.push({
          tenant_id: t.id, slug: t.slug, display_name: t.display_name,
          fees_waived: !!t.platform_fees_waived, charges: 0,
          gross_cents: 0, refunded_cents: 0, net_cents: 0, buckets: blank(),
        });
      }
    }

    return jsonResponse({
      ok: true,
      configured: true,
      source: 'stripe.application_fees',
      window_days: days,
      truncated: pages >= MAX_PAGES,
      network: {
        charges:        network.count,
        gross_cents:    network.gross,
        refunded_cents: network.refunded,
        net_cents:      Math.max(0, network.gross - network.refunded),
        buckets:        network.buckets,
        // Charges on a connected account we no longer have a tenant row for.
        unmatched_accounts: [...network.unmatched_accounts],
      },
      clubs,
    });
  }

  const sevenDaysAgo  = new Date(Date.now() -  7 * 86400_000).toISOString();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();

  // Stripe platform health — env presence + per-tenant onboarding state.
  // Setting STRIPE_SECRET_KEY on the platform unlocks the Connect button
  // for ALL tenants instantly; this surface tells Doug whether keys are
  // set and how many clubs are actually onboarded.
  const stripeSecretSet  = !!Deno.env.get('STRIPE_SECRET_KEY');
  const stripeWebhookSet = !!Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const resendSet = !!Deno.env.get('RESEND_API_KEY');
  const twilioSet = !!(Deno.env.get('TWILIO_ACCOUNT_SID') && Deno.env.get('TWILIO_AUTH_TOKEN') && Deno.env.get('TWILIO_FROM_NUMBER'));
  const googleSet = !!(Deno.env.get('GOOGLE_CLIENT_ID') && Deno.env.get('GOOGLE_CLIENT_SECRET'));

  // Run every count in parallel — supabase head:true returns count without rows
  const headCount = (q: PromiseLike<{ count: number | null }>) =>
    Promise.resolve(q).then(r => r.count ?? 0);

  const [
    tenantsTotal, tenantsActive, tenantsTrial, tenantsChurned,
    tenantsLast7d, tenantsLast30d,
    households, members,
    events, posts, photos,
    applicationsPending, applicationsApproved,
    partiesApproved, partiesPending,
    memberSignInsTotal, memberSignIns7d,
    recentTenants,
  ] = await Promise.all([
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true })),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).eq('status', 'active')),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).eq('status', 'trial')),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).eq('status', 'churned')),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).gte('created_at', sevenDaysAgo)),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo)),
    headCount(sb.from('households').select('id', { count: 'exact', head: true }).eq('active', true)),
    headCount(sb.from('household_members').select('id', { count: 'exact', head: true }).eq('active', true)),
    headCount(sb.from('events').select('id', { count: 'exact', head: true }).eq('active', true)),
    headCount(sb.from('posts').select('id', { count: 'exact', head: true }).eq('active', true)),
    headCount(sb.from('photos').select('id', { count: 'exact', head: true }).eq('active', true)),
    headCount(sb.from('applications').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
    headCount(sb.from('applications').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
    headCount(sb.from('party_bookings').select('id', { count: 'exact', head: true }).eq('status', 'approved')),
    headCount(sb.from('party_bookings').select('id', { count: 'exact', head: true }).eq('status', 'pending')),
    headCount(sb.from('member_magic_links').select('id', { count: 'exact', head: true }).not('used_at', 'is', null)),
    headCount(sb.from('member_magic_links').select('id', { count: 'exact', head: true }).gte('used_at', sevenDaysAgo)),
    sb.from('tenants').select('id, slug, display_name, status, plan, created_at')
      .order('created_at', { ascending: false }).limit(15),
  ]);

  // Stripe per-tenant onboarding counts (parallelized separately so the
  // primary metrics call doesn't fail if these tables aren't populated yet).
  const [
    stripeConnected,
    stripeChargesReady,
    stripePayoutsReady,
  ] = await Promise.all([
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).not('stripe_account_id', 'is', null)),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).eq('stripe_charges_enabled', true)),
    headCount(sb.from('tenants').select('id', { count: 'exact', head: true }).eq('stripe_payouts_enabled', true)),
  ]);

  // Per-tenant household counts so the recent-tenants table can show size
  const tenantIds = (recentTenants.data ?? []).map(t => t.id);
  const householdsByTenant: Record<string, number> = {};
  if (tenantIds.length) {
    const { data: hhRows } = await sb.from('households')
      .select('tenant_id').in('tenant_id', tenantIds).eq('active', true);
    for (const r of (hhRows ?? [])) {
      const k = r.tenant_id as string;
      householdsByTenant[k] = (householdsByTenant[k] || 0) + 1;
    }
  }

  return jsonResponse({
    ok: true,
    tenants: {
      total: tenantsTotal,
      active: tenantsActive,
      trial: tenantsTrial,
      churned: tenantsChurned,
      new_7d: tenantsLast7d,
      new_30d: tenantsLast30d,
    },
    network: {
      households, members,
      events, posts, photos,
      member_sign_ins_total: memberSignInsTotal,
      member_sign_ins_7d:    memberSignIns7d,
    },
    pipeline: {
      applications_pending:  applicationsPending,
      applications_approved: applicationsApproved,
      parties_pending:       partiesPending,
      parties_approved:      partiesApproved,
    },
    recent_tenants: (recentTenants.data ?? []).map(t => ({
      ...t,
      household_count: householdsByTenant[t.id as string] || 0,
    })),
    stripe_platform: {
      secret_set:        stripeSecretSet,
      webhook_set:       stripeWebhookSet,
      connected_tenants: stripeConnected,
      ready_tenants:     stripeChargesReady,
      payouts_ready:     stripePayoutsReady,
    },
    env_resend_set: resendSet,
    env_twilio_set: twilioSet,
    env_google_set: googleSet,
  });
});

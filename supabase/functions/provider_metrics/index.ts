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
    events, posts, photos, documents,
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
    headCount(sb.from('documents').select('id', { count: 'exact', head: true }).eq('active', true)),
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
      events, posts, photos, documents,
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

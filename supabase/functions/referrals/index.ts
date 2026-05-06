// =============================================================================
// referrals — refer-a-friend rewards engine
// =============================================================================
// "Get $100 off your dues for sharing the club" — member-driven growth loop.
//
// Flow:
//   1. Member opens 💌 Refer a friend modal → calls 'get_my_code' here.
//      We auto-generate a persistent code on first call (e.g. MARGARET-X4F2)
//      and return it + their stats.
//   2. Member shares <slug>.poolsideapp.com/apply.html?ref=MARGARET-X4F2
//   3. Friend opens the link → apply.html validates via 'validate_code',
//      shows a "Margaret invited you!" banner.
//   4. Friend submits application → applications.submit captures
//      referral_code on the row + creates a referrals row at status='applied'.
//   5. Payment clears (Stripe webhook OR admin marks Venmo verified) →
//      eligibility check fires (verify_referral action). If applicant's
//      email/phone wasn't a current OR prior member: status='verified'
//      and the referrer is notified. Else: status='rejected'.
//   6. Referrer opens the modal again → sees their reward is ready →
//      picks 'next_year_discount' (credits households.referral_credits_cents)
//      or 'current_year_refund' (creates an admin task for the treasurer).
//
// Actions:
//   { action: 'get_my_code' }                     → member JWT
//   { action: 'claim_reward', referral_id, reward_type }  → member JWT
//   { action: 'validate_code', code, slug }       → public, used by apply.html
//   { action: 'verify_referral', application_id, tenant_id }  → SERVICE-only,
//        called by stripe_webhook + applications.verify_payment + .approve
//   { action: 'list' }                            → admin JWT (membership scope)
//   { action: 'mark_rejected', referral_id, reason }  → admin JWT
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-poolside-internal',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type AnyPayload = Record<string, unknown>;
async function verifyJwt(token: string): Promise<AnyPayload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    return await verify(token, key) as AnyPayload;
  } catch { return null; }
}

// Generate a friendly code: FIRSTNAME-XXXX where XXXX is 4 random uppercase
// alphanumerics. Avoids 0/O/1/I to prevent share-via-text confusion.
const FRIENDLY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function genCode(name: string | null): string {
  const slug = (name || 'FRIEND').trim().split(/\s+/)[0]
    .toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'FRIEND';
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes).map(b => FRIENDLY_CHARS[b % FRIENDLY_CHARS.length]).join('');
  return `${slug}-${suffix}`;
}

function normalizeEmail(s: string | null | undefined): string | null {
  if (!s) return null;
  const trimmed = String(s).trim().toLowerCase();
  return trimmed.includes('@') ? trimmed : null;
}

// Eligibility gate: a referral counts ONLY if the applicant isn't a current
// or prior member of this tenant. Match on email + phone (separately — either
// hit means "this person was here before"). Address/family-name fuzzy match
// would catch more but introduces false positives — skip for v1.
async function isEligibleNewMember(
  sb: ReturnType<typeof createClient>,
  tenantId: string,
  email: string | null,
  phone: string | null,
): Promise<{ eligible: boolean; reason?: string }> {
  if (!email && !phone) return { eligible: true };  // nothing to match on

  // Match against EVERY household_member ever created on this tenant —
  // active or inactive. A returning member who lapsed and re-applied
  // shouldn't count as a "new member" for referral purposes.
  let query = sb.from('household_members')
    .select('id, name, active, created_at')
    .eq('tenant_id', tenantId);
  if (email) query = query.ilike('email', email);
  // Note: can't use OR with two ilike on different columns easily; do
  // separate phone check below.
  const { data: emailMatches } = await query;
  if (emailMatches && emailMatches.length) {
    return { eligible: false, reason: `Email ${email} was already on file as a member` };
  }

  if (phone) {
    const { data: phoneMatches } = await sb.from('household_members')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('phone_e164', phone);
    if (phoneMatches && phoneMatches.length) {
      return { eligible: false, reason: `Phone ${phone} was already on file as a member` };
    }
  }

  return { eligible: true };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  // ── Public: validate a code (used by apply.html when ?ref= is in URL) ──
  if (action === 'validate_code') {
    const code = String(body.code ?? '').trim().toUpperCase();
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!code || !slug) return jsonResponse({ ok: false, error: 'code + slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id, display_name').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const { data: rc } = await sb.from('referral_codes')
      .select('id, code, active, member_id, household_id')
      .eq('tenant_id', tenant.id).eq('code', code).maybeSingle();
    if (!rc || !rc.active) return jsonResponse({ ok: false, valid: false });
    // Resolve referrer's first name + family for the banner copy.
    const [{ data: member }, { data: hh }] = await Promise.all([
      sb.from('household_members').select('name').eq('id', rc.member_id).maybeSingle(),
      sb.from('households').select('family_name').eq('id', rc.household_id).maybeSingle(),
    ]);
    const referrerFirstName = member?.name ? String(member.name).trim().split(/\s+/)[0] : null;
    return jsonResponse({
      ok: true, valid: true,
      code: rc.code,
      referrer_first_name: referrerFirstName,
      referrer_family: hh?.family_name || null,
      tenant_display_name: tenant.display_name,
    });
  }

  // ── Service-internal: verify a referral after payment cleared ──────────
  // Called by stripe_webhook on checkout.session.completed AND by
  // applications.verify_payment when admin marks Venmo paid. Idempotent —
  // safe to call multiple times for the same application.
  if (action === 'verify_referral') {
    const internalKey = req.headers.get('x-poolside-internal') || req.headers.get('X-Poolside-Internal');
    const isInternal = internalKey && internalKey === SERVICE_ROLE;
    if (!isInternal) return jsonResponse({ ok: false, error: 'service-internal only' }, 401);

    const applicationId = String(body.application_id ?? '');
    const tenantId      = String(body.tenant_id ?? '');
    if (!applicationId || !tenantId) return jsonResponse({ ok: false, error: 'application_id + tenant_id required' }, 400);

    const { data: ref } = await sb.from('referrals')
      .select('id, status, applied_by_email, referral_code_id')
      .eq('application_id', applicationId)
      .eq('tenant_id', tenantId)
      .maybeSingle();
    if (!ref) return jsonResponse({ ok: true, message: 'no referral on this application' });
    if (ref.status !== 'applied') {
      return jsonResponse({ ok: true, message: `already ${ref.status}` });
    }

    // Pull the application's email + phone for eligibility check.
    const { data: app } = await sb.from('applications')
      .select('primary_email, primary_phone, family_name')
      .eq('id', applicationId).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'application not found' }, 404);

    const elig = await isEligibleNewMember(sb, tenantId, normalizeEmail(app.primary_email as string | null), app.primary_phone as string | null);
    if (!elig.eligible) {
      await sb.from('referrals').update({
        status: 'rejected',
        rejection_reason: elig.reason || 'Not a new member',
        updated_at: new Date().toISOString(),
      }).eq('id', ref.id);
      return jsonResponse({ ok: true, status: 'rejected', reason: elig.reason });
    }

    await sb.from('referrals').update({
      status: 'verified',
      updated_at: new Date().toISOString(),
    }).eq('id', ref.id);

    // Notify referrer via admin task (admins see membership-related tasks)
    // + audit log so the trail is durable.
    const { data: rc } = await sb.from('referral_codes')
      .select('member_id, household_id').eq('id', ref.referral_code_id).maybeSingle();
    if (rc) {
      const { data: ref_member } = await sb.from('household_members')
        .select('name').eq('id', rc.member_id).maybeSingle();
      await sb.from('audit_log').insert({
        tenant_id: tenantId,
        kind: 'referral.verified',
        entity_type: 'referral', entity_id: ref.id,
        summary: `Referral verified: ${ref_member?.name || 'A member'} earned $${10000 / 100} for inviting ${app.family_name || app.primary_email}`,
        actor_kind: 'system',
        metadata: { application_id: applicationId, referral_id: ref.id },
      });
    }
    return jsonResponse({ ok: true, status: 'verified' });
  }

  // ── Below this point: actions require auth ──────────────────────────────
  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyJwt(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);

  const tid = String(payload.tid || '');
  const sub = String(payload.sub || '');
  const kind = String(payload.kind || '');

  // ── Member: get_my_code ────────────────────────────────────────────────
  if (action === 'get_my_code') {
    if (kind !== 'member') return jsonResponse({ ok: false, error: 'Members only' }, 403);

    // Make sure this member exists + is active + has a household
    const { data: member } = await sb.from('household_members')
      .select('id, name, active, household_id').eq('id', sub).maybeSingle();
    if (!member || !member.active) return jsonResponse({ ok: false, error: 'Member not active' }, 403);

    // Find or create their persistent code
    let { data: rc } = await sb.from('referral_codes')
      .select('id, code, active').eq('tenant_id', tid).eq('member_id', sub).maybeSingle();
    if (!rc) {
      // Generate, retry on (vanishingly rare) collision
      let attempts = 0;
      while (attempts < 5) {
        const code = genCode(member.name as string | null);
        const { data: inserted, error } = await sb.from('referral_codes').insert({
          tenant_id: tid,
          member_id: sub,
          household_id: member.household_id,
          code,
        }).select('id, code, active').single();
        if (!error) { rc = inserted; break; }
        attempts++;
      }
      if (!rc) return jsonResponse({ ok: false, error: 'Could not generate code' }, 500);
    }

    // Pull stats: how many invites used this code, breakdown by status, +
    // any rewards ready to claim (verified but not yet rewarded).
    const { data: usages } = await sb.from('referrals')
      .select('id, status, applied_by_email, applied_by_family, applied_at, reward_type, reward_amount_cents, reward_chosen_at')
      .eq('referral_code_id', rc.id)
      .order('applied_at', { ascending: false });
    const list = usages || [];
    const stats = {
      total_invites:     list.length,
      pending_payment:   list.filter(r => r.status === 'applied').length,
      verified_unclaimed: list.filter(r => r.status === 'verified').length,
      rewarded:          list.filter(r => r.status === 'rewarded').length,
      rejected:          list.filter(r => r.status === 'rejected').length,
      total_earned_cents: list.filter(r => r.status === 'rewarded').reduce((s, r) => s + (r.reward_amount_cents || 0), 0),
    };

    // Tenant slug for building the share URL on the client side
    const { data: tenant } = await sb.from('tenants').select('slug, display_name').eq('id', tid).maybeSingle();

    return jsonResponse({
      ok: true,
      code: rc.code,
      share_url: tenant ? `https://${tenant.slug}.poolsideapp.com/apply.html?ref=${rc.code}` : null,
      tenant_display_name: tenant?.display_name || null,
      stats,
      referrals: list.map(r => ({
        id: r.id,
        status: r.status,
        applied_at: r.applied_at,
        applied_by: r.applied_by_family || r.applied_by_email || 'Someone',
        reward_type: r.reward_type,
        reward_amount_cents: r.reward_amount_cents,
        reward_chosen_at: r.reward_chosen_at,
      })),
    });
  }

  // ── Member: claim_reward ───────────────────────────────────────────────
  if (action === 'claim_reward') {
    if (kind !== 'member') return jsonResponse({ ok: false, error: 'Members only' }, 403);

    const referralId = String(body.referral_id ?? '');
    const rewardType = String(body.reward_type ?? '');
    if (!referralId) return jsonResponse({ ok: false, error: 'referral_id required' }, 400);
    if (!['next_year_discount', 'current_year_refund'].includes(rewardType)) {
      return jsonResponse({ ok: false, error: 'Invalid reward_type' }, 400);
    }

    // Verify the referral belongs to this member (via the code)
    const { data: ref } = await sb.from('referrals')
      .select('id, status, referral_code_id, reward_amount_cents, applied_by_email, applied_by_family')
      .eq('id', referralId).eq('tenant_id', tid).maybeSingle();
    if (!ref) return jsonResponse({ ok: false, error: 'Referral not found' }, 404);
    if (ref.status !== 'verified') {
      return jsonResponse({ ok: false, error: `Cannot claim — status is ${ref.status}` }, 409);
    }

    const { data: rc } = await sb.from('referral_codes')
      .select('member_id, household_id').eq('id', ref.referral_code_id).maybeSingle();
    if (!rc || rc.member_id !== sub) {
      return jsonResponse({ ok: false, error: 'Not your referral' }, 403);
    }

    const now = new Date().toISOString();
    const amount = Number(ref.reward_amount_cents || 10000);

    // Apply the reward immediately based on type chosen.
    if (rewardType === 'next_year_discount') {
      // Add to household credit accumulator. Done — admin sees this when
      // they roll over for next season.
      const { data: hh } = await sb.from('households')
        .select('referral_credits_cents').eq('id', rc.household_id).maybeSingle();
      const newCredits = (hh?.referral_credits_cents ?? 0) + amount;
      await sb.from('households')
        .update({ referral_credits_cents: newCredits })
        .eq('id', rc.household_id);
    } else {
      // 'current_year_refund' — admin task for the treasurer to issue.
      // We don't auto-refund Stripe charges from member action; admin reviews.
      const { data: member } = await sb.from('household_members')
        .select('name').eq('id', sub).maybeSingle();
      await sb.from('admin_tasks').insert({
        tenant_id: tid,
        target_scopes: ['payments'],
        kind: 'referral.refund_request',
        summary: `${member?.name || 'A member'} earned $${(amount / 100).toFixed(0)} referral credit — wants refund this year (referee: ${ref.applied_by_family || ref.applied_by_email})`,
        link_url: '/club/admin/payments.html',
        source_kind: 'referral', source_id: ref.id,
      });
    }

    await sb.from('referrals').update({
      status: 'rewarded',
      reward_type: rewardType,
      reward_chosen_at: now,
      reward_applied_at: now,
      updated_at: now,
    }).eq('id', referralId);

    await sb.from('audit_log').insert({
      tenant_id: tid,
      kind: 'referral.rewarded',
      entity_type: 'referral', entity_id: referralId,
      summary: `Referral reward $${(amount / 100).toFixed(0)} ${rewardType === 'next_year_discount' ? 'credited to next year\'s dues' : 'queued as refund'}`,
      actor_id: sub, actor_kind: 'member',
    });

    return jsonResponse({ ok: true, reward_type: rewardType, amount_cents: amount });
  }

  // ── Admin: list (enriched with both-membership facts) ──────────────────
  if (action === 'list') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);

    const { data: refs } = await sb.from('referrals')
      .select(`
        id, status, applied_at, applied_by_email, applied_by_family,
        reward_type, reward_amount_cents, reward_chosen_at,
        rejection_reason, application_id, referral_code_id,
        refund_method, refund_id, refund_at, refund_by, refund_decline_reason
      `)
      .eq('tenant_id', tid)
      .order('applied_at', { ascending: false })
      .limit(200);

    if (!refs || !refs.length) return jsonResponse({ ok: true, referrals: [] });

    // Pull referrer info (member + household)
    const codeIds = [...new Set(refs.map(r => r.referral_code_id))];
    const { data: codes } = await sb.from('referral_codes')
      .select('id, code, member_id, household_id').in('id', codeIds);
    const codeById = new Map((codes ?? []).map(c => [c.id, c]));

    const refMemberIds = [...new Set((codes ?? []).map(c => c.member_id))];
    const refHhIds     = [...new Set((codes ?? []).map(c => c.household_id))];
    const { data: refMembers } = refMemberIds.length
      ? await sb.from('household_members').select('id, name, active, household_id').in('id', refMemberIds)
      : { data: [] };
    const { data: refHhs } = refHhIds.length
      ? await sb.from('households').select('id, family_name, dues_paid_for_year, paid_until_year, active').in('id', refHhIds)
      : { data: [] };
    const refMemberById = new Map((refMembers ?? []).map(m => [m.id, m]));
    const refHhById     = new Map((refHhs ?? []).map(h => [h.id, h]));

    // Pull referrer's most recent application for refund-channel detection
    const { data: refApps } = refMemberIds.length
      ? await sb.from('applications')
          .select('id, household_id, payment_method, payment_status, stripe_payment_intent_id, paid_at, paid_until_year')
          .in('household_id', refHhIds)
          .order('created_at', { ascending: false })
      : { data: [] };
    const refAppByHhId = new Map();
    (refApps ?? []).forEach(a => {
      if (!refAppByHhId.has(a.household_id)) refAppByHhId.set(a.household_id, a);
    });

    // Pull referee info (the application that came in via the code)
    const refereeAppIds = refs.map(r => r.application_id).filter(Boolean) as string[];
    const { data: refereeApps } = refereeAppIds.length
      ? await sb.from('applications')
          .select('id, family_name, primary_name, primary_email, primary_phone, payment_method, payment_status, paid_at, paid_until_year, status')
          .in('id', refereeAppIds)
      : { data: [] };
    const refereeAppById = new Map((refereeApps ?? []).map(a => [a.id, a]));

    const enriched = refs.map(r => {
      const code = codeById.get(r.referral_code_id);
      const refMember = code ? refMemberById.get(code.member_id) : null;
      const refHh     = code ? refHhById.get(code.household_id) : null;
      const refApp    = refHh ? refAppByHhId.get(refHh.id) : null;
      const refereeApp = r.application_id ? refereeAppById.get(r.application_id) : null;

      const refundChannelHint = (() => {
        if (!refApp) return 'unknown';
        if (refApp.payment_method === 'stripe' && refApp.stripe_payment_intent_id) return 'stripe';
        return 'manual';   // venmo/check/etc — admin handles off-platform
      })();

      return {
        // The referral itself
        id: r.id,
        status: r.status,
        applied_at: r.applied_at,
        reward_type: r.reward_type,
        reward_amount_cents: r.reward_amount_cents,
        reward_chosen_at: r.reward_chosen_at,
        rejection_reason: r.rejection_reason,

        // Refund disposition
        refund_method: r.refund_method,
        refund_id: r.refund_id,
        refund_at: r.refund_at,
        refund_decline_reason: r.refund_decline_reason,

        // Referrer (the member earning the reward)
        referrer: {
          name: refMember?.name || 'Unknown',
          family: refHh?.family_name || null,
          active: !!refMember?.active,
          household_active: !!refHh?.active,
          dues_paid: !!refHh?.dues_paid_for_year,
          paid_until_year: refHh?.paid_until_year || null,
          payment_method: refApp?.payment_method || null,
          stripe_payment_intent_id: refApp?.stripe_payment_intent_id || null,
        },
        // Referee (the new applicant who used the code)
        referee: refereeApp ? {
          family: refereeApp.family_name,
          name: refereeApp.primary_name,
          email: refereeApp.primary_email,
          payment_method: refereeApp.payment_method,
          payment_status: refereeApp.payment_status,
          paid_at: refereeApp.paid_at,
          status: refereeApp.status,
        } : null,

        // What admin can do
        refund_channel_hint: refundChannelHint,   // 'stripe' | 'manual' | 'unknown'
        is_pending_refund: r.reward_type === 'current_year_refund' && r.status === 'rewarded' && !r.refund_at,
      };
    });

    return jsonResponse({ ok: true, referrals: enriched });
  }

  // ── Admin: issue_refund — record disposition AND optionally fire the
  //    Stripe refund API call for card-paid referrers. Payments-scope only.
  if (action === 'issue_refund') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);
    // Scope check: payments
    const { requireScope } = await import('../_shared/auth.ts');
    if (!(await requireScope(sb, payload as never, 'payments'))) {
      return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);
    }

    const referralId  = String(body.referral_id ?? '');
    const method      = String(body.method ?? '');   // 'stripe' | 'venmo' | 'check'
    const note        = body.note ? String(body.note).slice(0, 500) : null;
    if (!referralId)                                 return jsonResponse({ ok: false, error: 'referral_id required' }, 400);
    if (!['stripe', 'venmo', 'check'].includes(method)) {
      return jsonResponse({ ok: false, error: 'method must be stripe / venmo / check' }, 400);
    }

    // Load + sanity-check the referral
    const { data: ref } = await sb.from('referrals')
      .select('id, status, reward_type, reward_amount_cents, refund_at, application_id, referral_code_id')
      .eq('id', referralId).eq('tenant_id', tid).maybeSingle();
    if (!ref) return jsonResponse({ ok: false, error: 'Referral not found' }, 404);
    if (ref.status !== 'rewarded' || ref.reward_type !== 'current_year_refund') {
      return jsonResponse({ ok: false, error: 'Only refund-type rewards in rewarded state can be issued' }, 409);
    }
    if (ref.refund_at) {
      return jsonResponse({ ok: false, error: 'Refund already recorded for this referral' }, 409);
    }

    const amount = Number(ref.reward_amount_cents || 10000);
    const now = new Date().toISOString();
    let refundId: string | null = null;

    // Stripe path: actually call the API. Manual paths (venmo/check) just
    // record the admin's action — the human did the off-platform work.
    if (method === 'stripe') {
      // Find the referrer's household + their most recent paid application
      const { data: code } = await sb.from('referral_codes')
        .select('household_id').eq('id', ref.referral_code_id).maybeSingle();
      if (!code) return jsonResponse({ ok: false, error: 'Referral code missing' }, 500);
      const { data: refApp } = await sb.from('applications')
        .select('id, payment_method, stripe_payment_intent_id')
        .eq('household_id', code.household_id)
        .eq('payment_status', 'paid')
        .order('paid_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!refApp || refApp.payment_method !== 'stripe' || !refApp.stripe_payment_intent_id) {
        return jsonResponse({ ok: false, error: 'Referrer has no recent Stripe-paid application — use Venmo or check instead' }, 409);
      }

      // Look up the tenant's connected Stripe account
      const { data: tenant } = await sb.from('tenants')
        .select('stripe_account_id').eq('id', tid).maybeSingle();
      const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY');
      if (!STRIPE_KEY)                                 return jsonResponse({ ok: false, error: 'Stripe not configured on platform' }, 503);
      if (!tenant?.stripe_account_id)                  return jsonResponse({ ok: false, error: 'This club isn\'t connected to Stripe yet' }, 503);

      const params = new URLSearchParams();
      params.append('payment_intent', refApp.stripe_payment_intent_id);
      params.append('amount', String(amount));
      params.append('reason', 'requested_by_customer');
      params.append('metadata[poolside_kind]', 'referral_reward');
      params.append('metadata[referral_id]', referralId);
      try {
        const res = await fetch('https://api.stripe.com/v1/refunds', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${STRIPE_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Stripe-Account': tenant.stripe_account_id,
          },
          body: params.toString(),
        });
        const data = await res.json();
        if (!res.ok) {
          return jsonResponse({ ok: false, error: data?.error?.message || `Stripe ${res.status}: refund failed`, stripe_code: data?.error?.code }, 500);
        }
        refundId = data.id;
      } catch (e) {
        return jsonResponse({ ok: false, error: `Stripe call failed: ${(e as Error).message}` }, 500);
      }
    } else {
      // venmo / check — admin's note is the receipt
      refundId = note || `${method} (manual)`;
    }

    // Record the disposition
    const { error: updErr } = await sb.from('referrals').update({
      refund_method: method,
      refund_id: refundId,
      refund_amount_cents: amount,
      refund_at: now,
      refund_by: sub,
      updated_at: now,
    }).eq('id', referralId);
    if (updErr) return jsonResponse({ ok: false, error: updErr.message }, 500);

    // Close the related admin task
    await sb.from('admin_tasks')
      .update({ completed_at: now, completed_by: sub })
      .eq('tenant_id', tid).eq('source_kind', 'referral').eq('source_id', referralId)
      .is('completed_at', null);

    await sb.from('audit_log').insert({
      tenant_id: tid,
      kind: 'referral.refund_issued',
      entity_type: 'referral', entity_id: referralId,
      summary: `Refund $${(amount / 100).toFixed(0)} issued via ${method}${refundId ? ' (' + String(refundId).slice(0, 80) + ')' : ''}`,
      actor_id: sub, actor_kind: 'tenant_admin',
      metadata: { method, amount_cents: amount, refund_id: refundId },
    });

    return jsonResponse({ ok: true, method, refund_id: refundId, amount_cents: amount });
  }

  // ── Admin: decline_refund — admin says "this isn't legit, no money out" ─
  if (action === 'decline_refund') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);
    const { requireScope } = await import('../_shared/auth.ts');
    if (!(await requireScope(sb, payload as never, 'payments'))) {
      return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);
    }
    const referralId = String(body.referral_id ?? '');
    const reason     = String(body.reason ?? '').trim();
    if (!referralId)                          return jsonResponse({ ok: false, error: 'referral_id required' }, 400);
    if (!reason)                              return jsonResponse({ ok: false, error: 'A reason is required when declining' }, 400);

    const { data: ref } = await sb.from('referrals')
      .select('id, status, refund_at').eq('id', referralId).eq('tenant_id', tid).maybeSingle();
    if (!ref)                                 return jsonResponse({ ok: false, error: 'Referral not found' }, 404);
    if (ref.refund_at)                        return jsonResponse({ ok: false, error: 'Already disposed' }, 409);

    const now = new Date().toISOString();
    await sb.from('referrals').update({
      refund_method: 'declined',
      refund_decline_reason: reason.slice(0, 500),
      refund_at: now,
      refund_by: sub,
      updated_at: now,
    }).eq('id', referralId);

    await sb.from('admin_tasks')
      .update({ completed_at: now, completed_by: sub })
      .eq('tenant_id', tid).eq('source_kind', 'referral').eq('source_id', referralId)
      .is('completed_at', null);

    await sb.from('audit_log').insert({
      tenant_id: tid,
      kind: 'referral.refund_declined',
      entity_type: 'referral', entity_id: referralId,
      summary: `Refund declined: ${reason.slice(0, 120)}`,
      actor_id: sub, actor_kind: 'tenant_admin',
      metadata: { reason },
    });

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

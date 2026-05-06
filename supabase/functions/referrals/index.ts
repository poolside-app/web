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

  // ── Admin: list ────────────────────────────────────────────────────────
  if (action === 'list') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);
    // No scope check — visible to all admins; reading audit data isn't sensitive
    const { data: refs } = await sb.from('referrals')
      .select('id, status, applied_at, applied_by_email, applied_by_family, reward_type, reward_amount_cents, rejection_reason, reward_chosen_at, referral_code_id, application_id')
      .eq('tenant_id', tid)
      .order('applied_at', { ascending: false })
      .limit(200);
    const codeIds = [...new Set((refs ?? []).map(r => r.referral_code_id))];
    const { data: codes } = codeIds.length
      ? await sb.from('referral_codes').select('id, code, member_id').in('id', codeIds)
      : { data: [] };
    const memberIds = [...new Set((codes ?? []).map(c => c.member_id))];
    const { data: members } = memberIds.length
      ? await sb.from('household_members').select('id, name').in('id', memberIds)
      : { data: [] };
    const codeById = new Map((codes ?? []).map(c => [c.id, c]));
    const memberById = new Map((members ?? []).map(m => [m.id, m]));
    const enriched = (refs ?? []).map(r => {
      const code = codeById.get(r.referral_code_id);
      const member = code ? memberById.get(code.member_id) : null;
      return {
        ...r,
        referrer_name: member?.name || 'Unknown',
        referral_code: code?.code || '',
      };
    });
    return jsonResponse({ ok: true, referrals: enriched });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

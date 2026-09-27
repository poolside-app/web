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
//   6. Referrer opens the modal again → sees their reward is ready → picks
//      'next_year_discount' or 'current_year_refund'. This RECORDS A REQUEST
//      and applies nothing: status becomes 'claimed' and a task goes to the
//      board.
//   7. A board member with the payments scope approves or declines it
//      ('approve_reward' / 'decline_reward'). Approval is the first moment
//      anything happens — a next-season credit is written to the household
//      then, and a refund merely becomes issuable, with a treasurer still
//      having to record the money going out through 'issue_refund'.
//
//      No money and no credit ever moves without a named person deciding.
//      The cap is re-checked at approval rather than trusted from claim time,
//      because weeks can pass waiting on a board meeting.
//
// H6 (Doug, 2026-09-26) changed the timeline: verifying a referral starts a
// 30-day wait and texts the member the unlock date; the member picks credit
// (the default) or a refund at any point; the daily payment_plans job moves
// unlocked rewards to the board (unlockDueRewards); approval needs the
// payments permission, never for your own family, and not before unlock; a
// Venmo or check refund needs its reference. See _shared/referral_rewards.ts.
//
// Actions:
//   { action: 'get_my_code' }                     → member JWT
//   { action: 'claim_reward', referral_id, reward_type }  → member JWT
//   { action: 'validate_code', code, slug }       → public, used by apply.html
//   { action: 'verify_referral', application_id, tenant_id }  → SERVICE-only,
//        called by stripe_webhook + applications.verify_payment + .approve
//   { action: 'list' }                            → admin JWT (membership scope)
//   { action: 'mark_rejected', referral_id, reason }  → admin JWT
//   { action: 'approve_reward', referral_id }          → admin JWT + payments
//   { action: 'decline_reward', referral_id, reason }  → admin JWT + payments
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { capState, grantableReward } from '../_shared/referral_cap.ts';
import { referralSettings } from '../_shared/pricing.ts';
import {
  unlockAt, shortDate, dollars, theFamily, approvalProblem, isOwnFamily, referrerOf,
  paidText, approvedText, sentText, declinedText, textReferrer, unlockDueRewards,
} from '../_shared/referral_rewards.ts';
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
// ── The cap ────────────────────────────────────────────────────────────
// A member can earn up to the price of their own membership and no further.
// Refer enough neighbors and your season is free; refer more and the club
// does not start owing you money.
//
// Counted from the referrals table rather than households.referral_credits_
// cents, which only records the "discount next year" choice. The refund
// choice creates a task for the treasurer and touches no column — so a member
// alternating between the two would have been capped on half their rewards
// and uncapped on the other half. The rewarded rows are the only place both
// appear.
async function referralCap(
  sb: ReturnType<typeof createClient>,
  tenantId: string,
  householdId: string | null,
): Promise<{ dues_cents: number; awarded_cents: number; remaining_cents: number; uncapped: boolean }> {
  if (!householdId) return { ...capState(0, 0), uncapped: false };

  const [{ data: hh }, { data: settingsRow }] = await Promise.all([
    sb.from('households').select('tier').eq('id', householdId).maybeSingle(),
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  const sv = (settingsRow?.value ?? {}) as Record<string, unknown>;
  const tiers = (sv.membership_tiers as Array<Record<string, unknown>> | undefined) ?? [];

  const own = tiers.find(t => t.slug === hh?.tier);
  let dues = Number(own?.price_cents ?? 0) || 0;
  if (!dues) {
    // Their own tier has no price — fall back to the cheapest one the club
    // has configured, so a missing tier does not silently uncap them.
    const priced = tiers.map(t => Number(t.price_cents ?? 0)).filter(n => n > 0);
    dues = priced.length ? Math.min(...priced) : 0;
  }
  // A club with no priced tiers at all is not collecting dues through Poolside,
  // so "up to the price of a membership" has nothing to measure against. Let
  // the reward through rather than blocking it on missing configuration.
  if (!dues) return capState(0, 0);

  const { data: codes } = await sb.from('referral_codes')
    .select('id').eq('tenant_id', tenantId).eq('household_id', householdId);
  const codeIds = (codes ?? []).map(c => c.id as string);
  let awarded = 0;
  if (codeIds.length) {
    const { data: rewarded } = await sb.from('referrals')
      .select('reward_amount_cents')
      .eq('tenant_id', tenantId).eq('status', 'rewarded')
      .in('referral_code_id', codeIds);
    awarded = (rewarded ?? []).reduce((n, r) => n + (Number(r.reward_amount_cents) || 0), 0);
  }
  return capState(dues, awarded);
}

async function isEligibleNewMember(
  sb: ReturnType<typeof createClient>,
  tenantId: string,
  email: string | null,
  phone: string | null,
  // The new family's own household. By the time their payment is verified
  // they have been approved, so their own members exist and would otherwise
  // match — which rejected every referral.
  exceptHousehold?: string | null,
): Promise<{ eligible: boolean; reason?: string }> {
  if (!email && !phone) return { eligible: true };  // nothing to match on

  // Match against EVERY household_member ever created on this tenant —
  // active or inactive. A returning member who lapsed and re-applied
  // shouldn't count as a "new member" for referral purposes.
  let query = sb.from('household_members')
    .select('id, name, active, created_at')
    .eq('tenant_id', tenantId);
  if (exceptHousehold) query = query.neq('household_id', exceptHousehold);
  if (email) query = query.ilike('email', email);
  // Note: can't use OR with two ilike on different columns easily; do
  // separate phone check below.
  const { data: emailMatches } = await query;
  if (emailMatches && emailMatches.length) {
    return { eligible: false, reason: `Email ${email} was already on file as a member` };
  }

  if (phone) {
    let pq = sb.from('household_members')
      .select('id, name')
      .eq('tenant_id', tenantId)
      .eq('phone_e164', phone);
    if (exceptHousehold) pq = pq.neq('household_id', exceptHousehold);
    const { data: phoneMatches } = await pq;
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
    const { data: vs } = await sb.from('settings').select('value').eq('tenant_id', tenant.id).maybeSingle();
    const rules = referralSettings(vs?.value);
    return jsonResponse({
      ok: true, valid: true,
      new_family_cents: rules.new_family_cents,
      reward_cents: rules.reward_cents,
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
      .select('primary_email, primary_phone, family_name, household_id, paid_at')
      .eq('id', applicationId).maybeSingle();
    if (!app) return jsonResponse({ ok: false, error: 'application not found' }, 404);

    const elig = await isEligibleNewMember(sb, tenantId, normalizeEmail(app.primary_email as string | null),
      app.primary_phone as string | null, app.household_id as string | null);
    if (!elig.eligible) {
      await sb.from('referrals').update({
        status: 'rejected',
        rejection_reason: elig.reason || 'Not a new member',
        updated_at: new Date().toISOString(),
      }).eq('id', ref.id);
      return jsonResponse({ ok: true, status: 'rejected', reason: elig.reason });
    }

    // The 30-day wait starts now (H6). The reward is the club's setting at
    // the moment the family paid; the member's choice starts as credit.
    const paidAt = (app.paid_at as string | null) ?? new Date().toISOString();
    const unlocks = unlockAt(paidAt);
    const { data: settingsRow } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
    const reward = referralSettings(settingsRow?.value).reward_cents;
    await sb.from('referrals').update({
      status: 'verified',
      referee_paid_at: paidAt,
      unlocks_at: unlocks,
      reward_amount_cents: reward,
      reward_type: 'next_year_discount',
      updated_at: new Date().toISOString(),
    }).eq('id', ref.id);

    // Tell the member now, with the date. Audit log for the durable trail.
    const who = await referrerOf(sb as never, ref.referral_code_id as string);
    const { data: tenant } = await sb.from('tenants').select('display_name, timezone').eq('id', tenantId).maybeSingle();
    const { zoneOrDefault } = await import('../_shared/pool_time.ts');
    const unlockDay = shortDate(unlocks, zoneOrDefault(tenant?.timezone));
    const texted = await textReferrer(sb as never, tenantId, ref.referral_code_id as string,
      paidText((tenant?.display_name as string) || 'Your pool', app.family_name as string, reward, unlockDay),
      'referrals.verified');
    await sb.from('audit_log').insert({
      tenant_id: tenantId,
      kind: 'referral.verified',
      entity_type: 'referral', entity_id: ref.id,
      summary: `Referral verified: ${who?.name || 'A member'} (${theFamily(who?.family)}) referred ${theFamily(app.family_name as string)}. ${dollars(reward)} unlocks ${unlockDay}${texted ? '; member texted' : ''}`,
      actor_kind: 'system',
      metadata: { application_id: applicationId, referral_id: ref.id, unlocks_at: unlocks, reward_cents: reward },
    });
    return jsonResponse({ ok: true, status: 'verified', unlocks_at: unlocks });
  }

  // ── unlock_due: the daily sweep (H6). payment_plans' daily job runs the
  // same code directly; this entry point is for tests and a manual nudge.
  if (action === 'unlock_due') {
    const CRON_SECRET = Deno.env.get('CRON_SECRET');
    if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
      return jsonResponse({ ok: false, error: 'Bad cron secret' }, 401);
    }
    return jsonResponse({ ok: true, unlocked: await unlockDueRewards(sb as never) });
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
      .select('id, status, applied_by_email, applied_by_family, applied_at, reward_type, reward_amount_cents, reward_chosen_at, unlocks_at, decline_reason, void_reason, refund_at, refund_method')
      .eq('referral_code_id', rc.id)
      .order('applied_at', { ascending: false });
    const list = usages || [];
    const stats = {
      total_invites:     list.length,
      pending_payment:   list.filter(r => r.status === 'applied').length,
      verified_unclaimed: list.filter(r => r.status === 'verified' || r.status === 'claimed').length,
      rewarded:          list.filter(r => r.status === 'rewarded').length,
      rejected:          list.filter(r => r.status === 'rejected').length,
      total_earned_cents: list.filter(r => r.status === 'rewarded').reduce((s, r) => s + (r.reward_amount_cents || 0), 0),
    };

    // Tenant slug for building the share URL on the client side
    const { data: tenant } = await sb.from('tenants').select('slug, display_name').eq('id', tid).maybeSingle();
    const { data: codeSettings } = await sb.from('settings').select('value').eq('tenant_id', tid).maybeSingle();
    const rules = referralSettings(codeSettings?.value);

    return jsonResponse({
      ok: true,
      code: rc.code,
      // /join, not /apply.html. apply.html is rendered in the browser and its
      // static HTML says "Loading…" with no Open Graph tags, so a link pasted
      // into Nextdoor or a group chat unfurled as a card reading "Loading…".
      // /join is server-rendered by tenant_share with the club's name, photo
      // and price in the meta tags, and forwards the ref code to the form.
      share_url: tenant ? `https://${tenant.slug}.poolsideapp.com/join?ref=${rc.code}` : null,
      // How close they are to a free season. This is the motivating number —
      // "$400 of your $600 membership earned" is a target, where a count of
      // referrals is only a tally.
      cap: await referralCap(sb, tid, rc.household_id as string | null),
      tenant_display_name: tenant?.display_name || null,
      // The rules, shown up front in the Refer panel (H6).
      rules: { reward_cents: rules.reward_cents, new_family_cents: rules.new_family_cents, wait_days: rules.wait_days },
      stats,
      referrals: list.map(r => ({
        id: r.id,
        status: r.status,
        applied_at: r.applied_at,
        applied_by: r.applied_by_family || r.applied_by_email || 'Someone',
        reward_type: r.reward_type,
        reward_amount_cents: r.reward_amount_cents,
        reward_chosen_at: r.reward_chosen_at,
        unlocks_at: r.unlocks_at,
        decline_reason: r.decline_reason,
        void_reason: r.void_reason,
        refund_at: r.refund_at,
        refund_method: r.refund_method,
      })),
    });
  }

  // ── Member: claim_reward — choose credit or a refund (H6) ─────────────
  // The member can choose (or change their mind) any time before the board
  // approves. Nothing is applied here: at unlock the reward goes to the
  // board, and approval is the first moment anything happens. The cap is
  // applied then, since weeks pass in between.
  if (action === 'claim_reward' || action === 'choose_reward') {
    if (kind !== 'member') return jsonResponse({ ok: false, error: 'Members only' }, 403);

    const referralId = String(body.referral_id ?? '');
    const rewardType = String(body.reward_type ?? '');
    if (!referralId) return jsonResponse({ ok: false, error: 'referral_id required' }, 400);
    if (!['next_year_discount', 'current_year_refund'].includes(rewardType)) {
      return jsonResponse({ ok: false, error: 'Invalid reward_type' }, 400);
    }

    const { data: ref } = await sb.from('referrals')
      .select('id, status, referral_code_id, reward_type')
      .eq('id', referralId).eq('tenant_id', tid).maybeSingle();
    if (!ref) return jsonResponse({ ok: false, error: 'Referral not found' }, 404);
    const { data: rc } = await sb.from('referral_codes')
      .select('member_id').eq('id', ref.referral_code_id).maybeSingle();
    if (!rc || rc.member_id !== sub) return jsonResponse({ ok: false, error: 'Not your referral' }, 403);
    if (!['verified', 'claimed'].includes(String(ref.status))) {
      return jsonResponse({ ok: false, error: ref.status === 'applied'
        ? 'They haven\'t paid yet. You can choose once they have.'
        : 'The board has already decided on this one.' }, 409);
    }

    const now = new Date().toISOString();
    await sb.from('referrals').update({ reward_type: rewardType, reward_chosen_at: now, updated_at: now }).eq('id', referralId);
    if (ref.status === 'claimed') {
      // Already with the board: keep their task saying the right thing.
      await sb.from('admin_tasks').update({
        summary: `Referral reward: the member now wants ${rewardType === 'current_year_refund' ? 'a refund' : 'credit toward their dues'}`,
      }).eq('source_kind', 'referral').eq('source_id', referralId).is('completed_at', null);
    }
    await sb.from('audit_log').insert({
      tenant_id: tid,
      kind: 'referral.choice',
      entity_type: 'referral', entity_id: referralId,
      summary: `Member chose ${rewardType === 'next_year_discount' ? 'credit toward their dues' : 'a refund'} for their referral reward`,
      actor_id: sub, actor_kind: 'member',
    });
    return jsonResponse({ ok: true, reward_type: rewardType });
  }

  // ── Admin: list — the Referral rewards list under Money (H6) ──────────
  // "The Smiths referred the Johnsons", with both payments (date verified,
  // who verified it, transaction code), the unlock date, who approved and
  // paid it, and totals.
  if (action === 'list') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);

    const { data: refs } = await sb.from('referrals')
      .select(`
        id, status, applied_at, applied_by_email, applied_by_family,
        reward_type, reward_amount_cents, reward_chosen_at,
        rejection_reason, application_id, referral_code_id,
        refund_method, refund_id, refund_amount_cents, refund_at, refund_by, refund_decline_reason,
        approved_by, approved_at, declined_by, declined_at, decline_reason,
        referee_paid_at, unlocks_at, voided_at, void_reason
      `)
      .eq('tenant_id', tid)
      .order('applied_at', { ascending: false })
      .limit(300);

    // Totals: credit approved and not yet used, and cash sent this year.
    const { data: credits } = await sb.from('households').select('referral_credits_cents')
      .eq('tenant_id', tid).gt('referral_credits_cents', 0);
    const year = new Date().getUTCFullYear();
    const totals = {
      credit_owed_cents: (credits ?? []).reduce((n, h) => n + (Number(h.referral_credits_cents) || 0), 0),
      cash_paid_cents: (refs ?? []).filter(r => r.refund_at && ['stripe', 'venmo', 'check'].includes(String(r.refund_method))
        && String(r.refund_at).startsWith(String(year))).reduce((n, r) => n + (Number(r.refund_amount_cents) || 0), 0),
      waiting_for_approval: (refs ?? []).filter(r => r.status === 'claimed').length,
      in_waiting_period: (refs ?? []).filter(r => r.status === 'verified').length,
      year,
    };
    if (!refs || !refs.length) return jsonResponse({ ok: true, referrals: [], totals });

    const codeIds = [...new Set(refs.map(r => r.referral_code_id))];
    const { data: codes } = await sb.from('referral_codes').select('id, code, member_id, household_id').in('id', codeIds);
    const codeById = new Map((codes ?? []).map(c => [c.id, c]));
    const refMemberIds = [...new Set((codes ?? []).map(c => c.member_id))];
    const refHhIds = [...new Set((codes ?? []).map(c => c.household_id))];
    const [{ data: refMembers }, { data: refHhs }] = await Promise.all([
      sb.from('household_members').select('id, name, active').in('id', refMemberIds),
      sb.from('households').select('id, family_name, dues_paid_for_year, paid_until_year, active').in('id', refHhIds),
    ]);
    const refMemberById = new Map((refMembers ?? []).map(m => [m.id, m]));
    const refHhById = new Map((refHhs ?? []).map(h => [h.id, h]));

    const APP_FIELDS = 'id, household_id, family_name, primary_name, status, payment_method, payment_status, paid_at, verified_at, verified_by, stripe_payment_intent_id, stripe_session_id, payment_reference, amount_due_cents, membership_year';
    // The referrer's own most recent paid membership payment.
    const { data: refApps } = await sb.from('applications').select(APP_FIELDS)
      .in('household_id', refHhIds).eq('payment_status', 'paid').order('paid_at', { ascending: false });
    const refAppByHh = new Map();
    for (const a of refApps ?? []) if (!refAppByHh.has(a.household_id)) refAppByHh.set(a.household_id, a);
    const refereeIds = refs.map(r => r.application_id).filter(Boolean) as string[];
    const { data: refereeApps } = refereeIds.length
      ? await sb.from('applications').select(APP_FIELDS).in('id', refereeIds) : { data: [] };
    const refereeById = new Map((refereeApps ?? []).map(a => [a.id, a]));

    // Names for "verified by", "approved by", "paid by".
    const adminIds = new Set<string>();
    for (const a of [...(refApps ?? []), ...(refereeApps ?? [])]) if (a.verified_by) adminIds.add(a.verified_by as string);
    for (const r of refs) for (const k of ['approved_by', 'refund_by', 'declined_by'] as const) if (r[k]) adminIds.add(r[k] as string);
    const { data: admins } = adminIds.size
      ? await sb.from('admin_users').select('id, display_name, username').in('id', [...adminIds]) : { data: [] };
    const adminName = new Map((admins ?? []).map(a => [a.id, (a.display_name || a.username) as string]));

    // Whether the person looking is part of each referring family.
    const ownFamily = new Map<string, boolean>();
    for (const hh of refHhIds) ownFamily.set(hh as string, await isOwnFamily(sb as never, sub, hh as string));

    // deno-lint-ignore no-explicit-any
    const payment = (a: any) => a ? {
      application_id: a.id,
      method: a.payment_method, status: a.payment_status, season: a.membership_year,
      amount_cents: a.amount_due_cents,
      verified_at: a.verified_at || a.paid_at,
      verified_by: a.verified_by ? (adminName.get(a.verified_by) || 'A board member')
        : a.payment_method === 'stripe' ? 'Stripe (card)'
        : a.payment_method === 'free' ? 'Nothing to pay (covered by a discount)'
        : 'Automatic',
      // Stripe payment id, or the Venmo/check reference the board recorded.
      transaction: a.stripe_payment_intent_id || a.payment_reference || a.stripe_session_id || null,
    } : null;

    const enriched = refs.map(r => {
      const code = codeById.get(r.referral_code_id);
      const refMember = code ? refMemberById.get(code.member_id) : null;
      const refHh = code ? refHhById.get(code.household_id) : null;
      const refApp = refHh ? refAppByHh.get(refHh.id) : null;
      const refereeApp = r.application_id ? refereeById.get(r.application_id) : null;
      return {
        id: r.id,
        status: r.status,
        applied_at: r.applied_at,
        reward_type: r.reward_type,
        reward_amount_cents: r.reward_amount_cents,
        reward_chosen_at: r.reward_chosen_at,
        rejection_reason: r.rejection_reason,
        referee_paid_at: r.referee_paid_at,
        unlocks_at: r.unlocks_at,
        unlocked: !!r.unlocks_at && Date.now() >= new Date(r.unlocks_at).getTime(),
        approved_by: r.approved_by ? (adminName.get(r.approved_by) || 'A board member') : null,
        approved_at: r.approved_at,
        declined_by: r.declined_by ? (adminName.get(r.declined_by) || 'A board member') : null,
        decline_reason: r.decline_reason,
        voided_at: r.voided_at, void_reason: r.void_reason,
        refund_method: r.refund_method,
        refund_id: r.refund_id,
        refund_amount_cents: r.refund_amount_cents,
        refund_at: r.refund_at,
        refund_by: r.refund_by ? (adminName.get(r.refund_by) || 'A board member') : null,
        refund_decline_reason: r.refund_decline_reason,
        // "The Smiths referred the Johnsons"
        headline: `${theFamily(refHh?.family_name).replace(/^the/, 'The')} referred ${theFamily(refereeApp?.family_name || r.applied_by_family)}`,
        referrer: {
          name: refMember?.name || 'Unknown',
          family: refHh?.family_name || null,
          active: !!refMember?.active,
          household_active: !!refHh?.active,
          dues_paid: !!refHh?.dues_paid_for_year,
          paid_until_year: refHh?.paid_until_year || null,
          payment_method: refApp?.payment_method || null,
          stripe_payment_intent_id: refApp?.stripe_payment_intent_id || null,
          payment: payment(refApp),
        },
        referee: refereeApp ? {
          family: refereeApp.family_name,
          name: refereeApp.primary_name,
          payment_method: refereeApp.payment_method,
          payment_status: refereeApp.payment_status,
          paid_at: refereeApp.paid_at,
          status: refereeApp.status,
          payment: payment(refereeApp),
        } : null,
        own_family: code ? !!ownFamily.get(code.household_id) : false,
        refund_channel_hint: refApp?.payment_method === 'stripe' && refApp?.stripe_payment_intent_id ? 'stripe' : 'manual',
        is_pending_refund: r.reward_type === 'current_year_refund' && r.status === 'rewarded' && !r.refund_at,
        awaiting_board: r.status === 'claimed',
      };
    });

    return jsonResponse({ ok: true, referrals: enriched, totals });
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
    // A Venmo or check refund is only traceable by its reference (H6).
    if (method !== 'stripe' && !(note && note.trim().length >= 3)) {
      return jsonResponse({ ok: false, error: `The ${method === 'venmo' ? 'Venmo transaction' : 'check number'} reference is required.` }, 400);
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
    {
      const who = await referrerOf(sb as never, ref.referral_code_id as string);
      if (who && await isOwnFamily(sb as never, sub, who.household_id)) {
        return jsonResponse({ ok: false, error: "You can't send a reward to your own family. Another board member with the payments permission has to." }, 403);
      }
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

    {
      const { data: t } = await sb.from('tenants').select('display_name').eq('id', tid).maybeSingle();
      await textReferrer(sb as never, tid, ref.referral_code_id as string,
        sentText((t?.display_name as string) || 'Your pool', amount, method, method === 'stripe' ? null : note), 'referrals.refund_sent');
    }
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

  // ── approve_reward / decline_reward ────────────────────────────────────
  // The board decides. Nothing is credited or refunded before this runs, and
  // both reward types come through here — a credit against next season is
  // just as much the club's money as a refund is, it simply arrives as
  // revenue that never shows up.

  if (action === 'approve_reward') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);
    const { requireScope } = await import('../_shared/auth.ts');
    if (!(await requireScope(sb, payload as never, 'payments'))) {
      return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);
    }
    const referralId = String(body.referral_id ?? '');
    if (!referralId) return jsonResponse({ ok: false, error: 'referral_id required' }, 400);

    const { data: ref } = await sb.from('referrals')
      .select('id, status, reward_type, reward_amount_cents, referral_code_id, applied_by_family, unlocks_at, application_id')
      .eq('id', referralId).eq('tenant_id', tid).maybeSingle();
    if (!ref) return jsonResponse({ ok: false, error: 'Referral not found' }, 404);

    const { data: rc } = await sb.from('referral_codes')
      .select('member_id, household_id').eq('id', ref.referral_code_id).maybeSingle();
    if (!rc) return jsonResponse({ ok: false, error: 'Referral code missing' }, 500);

    // H6: not before the 30 days are up, never for your own family, and only
    // while the new family's payment still stands.
    const { data: refereeApp } = ref.application_id
      ? await sb.from('applications').select('payment_status').eq('id', ref.application_id).maybeSingle()
      : { data: null };
    const refereePaid = refereeApp?.payment_status === 'paid';
    const problem = approvalProblem({
      status: String(ref.status), unlocksAt: ref.unlocks_at as string | null, now: new Date(),
      ownFamily: await isOwnFamily(sb as never, sub, rc.household_id as string), refereePaid,
    });
    if (problem) {
      if (!refereePaid && ref.application_id && ['verified', 'claimed'].includes(String(ref.status))) {
        const { voidRewardsForApplication } = await import('../_shared/referral_rewards.ts');
        await voidRewardsForApplication(sb as never, ref.application_id as string, "The new family's payment is no longer paid");
      }
      return jsonResponse({ ok: false, error: problem }, 409);
    }

    // Re-check the cap here rather than trusting the figure worked out when
    // the member claimed. Weeks can pass waiting on a board meeting, and
    // other referrals may have been approved in between.
    const cap = await referralCap(sb, tid, rc.household_id as string | null);
    const amount = grantableReward(cap, Number(ref.reward_amount_cents || 10000));
    if (!cap.uncapped && amount <= 0) {
      return jsonResponse({
        ok: false, capped: true, cap,
        error: 'This household has already earned the full price of its membership.',
      }, 409);
    }

    const now = new Date().toISOString();

    // A credit against next season is applied now. A refund is not: approving
    // it only makes it issuable, and a treasurer still has to record the money
    // actually going out through issue_refund.
    if (ref.reward_type === 'next_year_discount') {
      const { data: hh } = await sb.from('households')
        .select('referral_credits_cents').eq('id', rc.household_id as string).maybeSingle();
      await sb.from('households')
        .update({ referral_credits_cents: Number(hh?.referral_credits_cents ?? 0) + amount })
        .eq('id', rc.household_id as string);
    }

    await sb.from('referrals').update({
      status: 'rewarded',
      reward_amount_cents: amount,     // what was actually approved
      approved_by: payload.sub, approved_at: now, updated_at: now,
    }).eq('id', referralId);

    // A credit is done now, so its board task is too. A refund's task stays
    // open until the money is recorded as sent.
    if (ref.reward_type !== 'current_year_refund') {
      await sb.from('admin_tasks').update({ completed_at: now, completed_by: payload.sub })
        .eq('tenant_id', tid).eq('source_kind', 'referral').eq('source_id', referralId).is('completed_at', null);
    }
    {
      const { data: t } = await sb.from('tenants').select('display_name').eq('id', tid).maybeSingle();
      await textReferrer(sb as never, tid, ref.referral_code_id as string,
        approvedText((t?.display_name as string) || 'Your pool', ref.applied_by_family as string, amount, ref.reward_type as string | null),
        'referrals.approved');
    }

    try {
      await sb.from('audit_log').insert({
        tenant_id: tid, kind: 'referral.reward_approved',
        entity_type: 'referral', entity_id: referralId,
        summary: `Approved a $${(amount / 100).toFixed(0)} referral reward (${ref.reward_type})`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
        metadata: { reward_type: ref.reward_type, amount_cents: amount, referred: ref.applied_by_family },
      });
    } catch { /* audit failure must not undo an approval */ }

    return jsonResponse({
      ok: true, amount_cents: amount, cap,
      needs_refund_issue: ref.reward_type === 'current_year_refund',
    });
  }

  if (action === 'decline_reward') {
    if (kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Admin only' }, 403);
    const { requireScope } = await import('../_shared/auth.ts');
    if (!(await requireScope(sb, payload as never, 'payments'))) {
      return jsonResponse({ ok: false, error: 'Missing payments scope' }, 403);
    }
    const referralId = String(body.referral_id ?? '');
    const reason = String(body.reason ?? '').trim();
    if (!referralId) return jsonResponse({ ok: false, error: 'referral_id required' }, 400);
    // A reason is required. "Declined" with no explanation is the version of
    // this that ends in an argument at a board meeting.
    if (!reason) return jsonResponse({ ok: false, error: 'Give a reason — the member will be told.' }, 400);

    const now = new Date().toISOString();
    const { data: updated, error } = await sb.from('referrals')
      .update({
        status: 'declined',
        declined_by: payload.sub, declined_at: now,
        decline_reason: reason.slice(0, 500), updated_at: now,
      })
      .eq('id', referralId).eq('tenant_id', tid).eq('status', 'claimed')
      .select('id').maybeSingle();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    if (!updated) return jsonResponse({ ok: false, error: 'Nothing to decline — it may already have been decided.' }, 409);
    await sb.from('admin_tasks').update({ completed_at: now, completed_by: payload.sub })
      .eq('tenant_id', tid).eq('source_kind', 'referral').eq('source_id', referralId).is('completed_at', null);
    {
      // The member is told, with the reason.
      const { data: r2 } = await sb.from('referrals').select('referral_code_id, applied_by_family').eq('id', referralId).maybeSingle();
      const { data: t } = await sb.from('tenants').select('display_name').eq('id', tid).maybeSingle();
      if (r2) await textReferrer(sb as never, tid, r2.referral_code_id as string,
        declinedText((t?.display_name as string) || 'Your pool', r2.applied_by_family as string, reason), 'referrals.declined');
    }

    try {
      await sb.from('audit_log').insert({
        tenant_id: tid, kind: 'referral.reward_declined',
        entity_type: 'referral', entity_id: referralId,
        summary: `Declined a referral reward — ${reason.slice(0, 120)}`,
        actor_id: payload.sub, actor_kind: 'tenant_admin',
        metadata: { reason },
      });
    } catch { /* audit failure must not undo a decision */ }

    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// =============================================================================
// referral_rewards.ts — the referral reward timeline (PLAN.md H6)
// =============================================================================
// Doug, 2026-09-26:
//   - A member earns $100 (settings.referrals.reward_cents) for each new
//     family who joins through their link and pays. The referring member
//     always earns it, whichever discount the new family ended up using.
//   - It unlocks 30 days after the new family's payment, and everyone knows
//     it: the member is texted when the family pays and on unlock day, the
//     Refer panel explains the rules, the approval screen shows the date.
//   - The member chooses credit toward their next dues (the default) or a
//     refund. Either way a board member with the payments permission
//     approves it, never for their own family.
//   - If the new family's payment is refunded or cancelled first, the reward
//     is void. Credit plus cash never adds up to more than the member's own
//     membership (referral_cap.ts).
//
// The pure parts are at the top so they can be tested without a database.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

// deno-lint-ignore no-explicit-any
type SB = SupabaseClient<any, any, any>;

export const WAIT_DAYS = 30;
const DAY = 86400_000;

/** When a reward unlocks: 30 days after the new family's payment cleared. */
export function unlockAt(paidAt: string | Date, waitDays = WAIT_DAYS): string {
  return new Date(new Date(paidAt).getTime() + waitDays * DAY).toISOString();
}

/** "Oct 26" in the pool's time zone. */
export function shortDate(iso: string, tz: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tz });
}

export function dollars(cents: number): string {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? String(d) : d.toFixed(2));
}

/** "the Johnsons" from "Johnson Family" / "Johnson" / "The Johnsons". */
export function theFamily(name: string | null | undefined): string {
  const raw = String(name ?? '').trim().replace(/\s+family$/i, '').replace(/^the\s+/i, '');
  if (!raw) return 'a new family';
  const plural = /s$/i.test(raw) ? raw : /(ch|sh|x|z)$/i.test(raw) ? raw + 'es' : raw + 's';
  return `the ${plural}`;
}
const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Why a board member can't approve this reward right now, or null. */
export function approvalProblem(args: {
  status: string;
  unlocksAt: string | null;
  now: Date;
  ownFamily: boolean;
  refereePaid: boolean;
}): string | null {
  if (args.ownFamily) return "You can't approve a reward for your own family. Another board member with the payments permission has to.";
  if (args.status !== 'claimed' && args.status !== 'verified') return `There's nothing to approve. It's ${args.status}.`;
  if (args.unlocksAt && args.now.getTime() < new Date(args.unlocksAt).getTime()) return 'It unlocks on its date. It can be approved then.';
  if (args.status === 'verified') return 'It unlocks on its date. It can be approved then.';
  if (!args.refereePaid) return "The new family's payment is no longer paid, so the reward is void.";
  return null;
}

export function paidText(club: string, family: string, cents: number, unlock: string): string {
  return `${club}: ${cap1(theFamily(family))} joined with your link. Your ${dollars(cents)} referral reward unlocks ${unlock}. `
    + `Credit toward your next dues, or a refund if you'd rather; you can choose in the app under Refer a friend.`;
}
export function unlockedText(club: string, family: string, cents: number, choice: string | null): string {
  return `${club}: your ${dollars(cents)} reward for referring ${theFamily(family)} has unlocked. `
    + `The board approves it next${choice === 'current_year_refund' ? ', then sends your refund.' : ', then it comes off your next dues.'}`;
}
export function approvedText(club: string, family: string, cents: number, choice: string | null): string {
  return choice === 'current_year_refund'
    ? `${club}: the board approved your ${dollars(cents)} reward for referring ${theFamily(family)}. We'll text you when the refund is sent.`
    : `${club}: the board approved your ${dollars(cents)} reward for referring ${theFamily(family)}. It comes off your next dues.`;
}
export function sentText(club: string, cents: number, method: string, reference: string | null): string {
  const how = method === 'stripe' ? 'back to your card (Stripe emails a receipt; 5 to 10 business days)'
    : method === 'venmo' ? `by Venmo${reference ? ` (${reference})` : ''}` : `by check${reference ? ` (${reference})` : ''}`;
  return `${club}: your ${dollars(cents)} referral refund was sent ${how}.`;
}
export function declinedText(club: string, family: string, reason: string): string {
  return `${club}: the board didn't approve your reward for referring ${theFamily(family)}. ${reason.trim().replace(/\.?$/, '.')}`;
}

// ── Database side ───────────────────────────────────────────────────────

export type Referrer = { member_id: string; household_id: string; name: string | null; phone: string | null; family: string | null };

export async function referrerOf(sb: SB, referralCodeId: string): Promise<Referrer | null> {
  const { data: rc } = await sb.from('referral_codes').select('member_id, household_id').eq('id', referralCodeId).maybeSingle();
  if (!rc) return null;
  const [{ data: m }, { data: hh }] = await Promise.all([
    sb.from('household_members').select('name, phone_e164').eq('id', rc.member_id).maybeSingle(),
    sb.from('households').select('family_name').eq('id', rc.household_id).maybeSingle(),
  ]);
  return {
    member_id: rc.member_id as string, household_id: rc.household_id as string,
    name: (m?.name as string | null) ?? null, phone: (m?.phone_e164 as string | null) ?? null,
    family: (hh?.family_name as string | null) ?? null,
  };
}

/** Is this board member part of that household? By their linked member,
 *  or a member of the household with their phone or email. */
export async function isOwnFamily(sb: SB, adminId: string, householdId: string): Promise<boolean> {
  const { data: admin } = await sb.from('admin_users').select('linked_member_id, phone_e164, email').eq('id', adminId).maybeSingle();
  if (!admin) return false;
  const { data: members } = await sb.from('household_members').select('id, phone_e164, email').eq('household_id', householdId);
  const email = String(admin.email ?? '').trim().toLowerCase();
  return (members ?? []).some(m =>
    m.id === admin.linked_member_id
    || (!!admin.phone_e164 && m.phone_e164 === admin.phone_e164)
    || (!!email && String(m.email ?? '').trim().toLowerCase() === email));
}

async function textMember(sb: SB, tenantId: string, to: string | null, body: string, source: string): Promise<boolean> {
  if (!to) return false;
  try {
    const { sendSms } = await import('./send_sms.ts');
    const { data: t } = await sb.from('tenants').select('plan').eq('id', tenantId).maybeSingle();
    const r = await sendSms({ sb: sb as never, tenantId, tenantPlan: t?.plan as string | null, to, body, kind: 'transactional', source });
    return r.sent;
  } catch { return false; }
}
export async function textReferrer(sb: SB, tenantId: string, referralCodeId: string, body: string, source: string): Promise<boolean> {
  const who = await referrerOf(sb, referralCodeId);
  return textMember(sb, tenantId, who?.phone ?? null, body, source);
}

async function clubInfo(sb: SB, tenantId: string): Promise<{ name: string; tz: string }> {
  const { data: t } = await sb.from('tenants').select('display_name, timezone').eq('id', tenantId).maybeSingle();
  const { zoneOrDefault } = await import('./pool_time.ts');
  return { name: (t?.display_name as string) || 'Your pool', tz: zoneOrDefault(t?.timezone) };
}

/**
 * The nightly sweep: rewards whose 30 days are up go to the board for
 * approval, and the member is told. Run from payment_plans' daily job.
 */
export async function unlockDueRewards(sb: SB, now = new Date()): Promise<number> {
  const { data: due } = await sb.from('referrals')
    .select('id, tenant_id, referral_code_id, applied_by_family, reward_amount_cents, reward_type, unlocks_at')
    .eq('status', 'verified').lte('unlocks_at', now.toISOString()).limit(200);
  let n = 0;
  for (const r of due ?? []) {
    const nowIso = new Date().toISOString();
    const { data: moved } = await sb.from('referrals').update({
      status: 'claimed',
      reward_type: r.reward_type ?? 'next_year_discount',
      reward_chosen_at: nowIso, updated_at: nowIso,
    }).eq('id', r.id).eq('status', 'verified').select('id').maybeSingle();
    if (!moved) continue;
    n++;
    const who = await referrerOf(sb, r.referral_code_id as string);
    const club = await clubInfo(sb, r.tenant_id as string);
    const amount = Number(r.reward_amount_cents) || 0;
    try {
      const { enqueueAdminTask } = await import('./enqueue_task.ts');
      await enqueueAdminTask(sb as never, {
        tenant_id: r.tenant_id as string,
        target_scopes: ['payments'],
        kind: 'referral.reward_request',
        summary: `${cap1(theFamily(who?.family))} referred ${theFamily(r.applied_by_family as string)}: approve their ${dollars(amount)} reward (${
          (r.reward_type ?? 'next_year_discount') === 'current_year_refund' ? 'refund' : 'credit'})`,
        link_url: '/club/admin/payments.html#referrals',
        source_kind: 'referral', source_id: r.id as string,
        push_title: '💌 Referral reward to approve',
        push_body: `${cap1(theFamily(who?.family))} referred ${theFamily(r.applied_by_family as string)}. ${dollars(amount)} is waiting for a payments board member.`,
      });
    } catch { /* the queue below still shows it */ }
    const texted = await textMember(sb, r.tenant_id as string, who?.phone ?? null,
      unlockedText(club.name, r.applied_by_family as string, amount, (r.reward_type as string | null) ?? 'next_year_discount'),
      'referrals.unlocked');
    await sb.from('referrals').update({ unlock_texted_at: texted ? new Date().toISOString() : null }).eq('id', r.id);
    try {
      await sb.from('audit_log').insert({
        tenant_id: r.tenant_id, kind: 'referral.unlocked', entity_type: 'referral', entity_id: r.id,
        summary: `Referral reward unlocked: ${cap1(theFamily(who?.family))} referred ${theFamily(r.applied_by_family as string)} (${dollars(amount)}), waiting for board approval`,
        actor_kind: 'system',
      });
    } catch { /* non-fatal */ }
  }
  return n;
}

/**
 * The new family's payment was refunded or their application cancelled: any
 * reward not yet approved for bringing them in is void.
 */
export async function voidRewardsForApplication(sb: SB, applicationId: string, reason: string): Promise<number> {
  const nowIso = new Date().toISOString();
  const { data: voided } = await sb.from('referrals')
    .update({ status: 'void', voided_at: nowIso, void_reason: reason.slice(0, 300), updated_at: nowIso })
    .eq('application_id', applicationId).in('status', ['applied', 'verified', 'claimed'])
    .select('id, tenant_id, applied_by_family');
  for (const r of voided ?? []) {
    await sb.from('admin_tasks').update({ completed_at: nowIso })
      .eq('source_kind', 'referral').eq('source_id', r.id).is('completed_at', null);
    try {
      await sb.from('audit_log').insert({
        tenant_id: r.tenant_id, kind: 'referral.void', entity_type: 'referral', entity_id: r.id,
        summary: `Referral reward for ${theFamily(r.applied_by_family as string)} is void: ${reason}`,
        actor_kind: 'system',
      });
    } catch { /* non-fatal */ }
  }
  return (voided ?? []).length;
}

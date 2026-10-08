// =============================================================================
// member_notify.ts — telling a member something (PLAN.md N, Doug 2026-10-07)
// =============================================================================
// A pop-up in the app for members who turned notifications on. Email where it
// makes sense, which the caller decides: `email` is sent when the pop-up
// didn't reach them, `alsoEmail` always (receipts and anything with payment
// details are records, so they're emailed regardless).
//
// No texts from here. Texts are only for "Text all members" (sms_blasts),
// sign-in codes and the welcome text when a family is approved.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export type Pop = { title: string; body: string; url?: string; tag?: string };

/** Pop-ups to members. Returns the member ids that at least one reached. */
export async function pushMembers(input: Pop & {
  tenant_id: string;
  member_ids?: string[];
  household_ids?: string[];
  all?: boolean;
}): Promise<{ sent: number; reached: string[] }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/push_member`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-poolside-internal': SERVICE_ROLE },
      body: JSON.stringify({ action: 'send', ...input }),
    });
    const d = await r.json().catch(() => ({}));
    return { sent: Number(d.sent ?? 0), reached: Array.isArray(d.reached) ? d.reached : [] };
  } catch (e) {
    console.error('pushMembers:', (e as Error).message);
    return { sent: 0, reached: [] };
  }
}

/**
 * One household: a pop-up to everyone in it who turned notifications on, and
 * an email to the person it's about when no pop-up reached the household
 * (or always, with alsoEmail).
 */
export async function notifyHousehold(sb: SupabaseClient, args: {
  tenantId: string;
  householdId: string;
  pop: Pop;
  email?: { to: string | null | undefined; send: () => Promise<unknown> } | null;
  alsoEmail?: boolean;
}): Promise<{ pushed: boolean; emailed: boolean }> {
  const p = await pushMembers({ tenant_id: args.tenantId, household_ids: [args.householdId], ...args.pop });
  const pushed = p.reached.length > 0;
  let emailed = false;
  if (args.email?.to && (args.alsoEmail || !pushed)) {
    try { await args.email.send(); emailed = true; }
    catch (e) { console.error('notifyHousehold email:', (e as Error).message); }
  }
  void sb;
  return { pushed, emailed };
}

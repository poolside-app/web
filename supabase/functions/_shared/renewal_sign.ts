// =============================================================================
// renewal_sign.ts — a renewal accepts the policies and is signed (PLAN.md R6)
// =============================================================================
// Doug, 2026-10-08: renewing (from the emailed link or in the app) shows
// everything filled in, but the family accepts the club's policies again and
// the person who opened the account signs, before paying. Checkout refuses a
// renewal that isn't signed (needsRenewalSignature), so no path skips it.
//
// Stored on the renewal application the same way signup stores it:
// waivers_accepted, accepted_at and signature_primary (a PNG data URL).
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/** The policies a family must accept (the ones required at signup). */
export async function requiredPolicies(sb: SupabaseClient, tenantId: string): Promise<string[]> {
  const { data } = await sb.from('policies').select('slug')
    .eq('tenant_id', tenantId).eq('active', true).eq('required_for_apply', true);
  return (data ?? []).map(p => String(p.slug));
}

/** True when a renewal still has to be signed before it can be paid. */
export function needsRenewalSignature(app: { is_renewal?: unknown; accepted_at?: unknown; signature_primary?: unknown }): boolean {
  return app.is_renewal === true && !(app.accepted_at && app.signature_primary);
}

/** A drawn signature: a PNG data URL, not empty, not huge. */
export function validSignature(sig: unknown): sig is string {
  return typeof sig === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) && sig.length >= 80 && sig.length <= 200000;
}

/**
 * Record the acceptance and signature on a renewal. Every required policy
 * must be accepted. Safe to repeat: a second signature replaces the first.
 */
export async function signRenewal(
  sb: SupabaseClient,
  app: { id: string; tenant_id: string; payment_status?: unknown; waivers_accepted?: unknown },
  input: { accepted?: unknown; signature?: unknown },
): Promise<{ ok: true; signed_at: string } | { ok: false; error: string }> {
  if (app.payment_status === 'paid') return { ok: false, error: 'This renewal is already paid.' };
  const required = await requiredPolicies(sb, app.tenant_id);
  const given = (input.accepted && typeof input.accepted === 'object' ? input.accepted : {}) as Record<string, unknown>;
  const missing = required.filter(slug => given[slug] !== true);
  if (missing.length) return { ok: false, error: `Accept ${missing.length === 1 ? 'the policy' : 'all ' + missing.length + ' policies'} first.` };
  if (!validSignature(input.signature)) return { ok: false, error: 'Sign in the box first.' };
  const waivers: Record<string, boolean> = { ...((app.waivers_accepted as Record<string, boolean> | null) ?? {}) };
  for (const slug of required) waivers[slug] = true;
  const now = new Date().toISOString();
  const { error } = await sb.from('applications').update({
    waivers_accepted: waivers, accepted_at: now, signature_primary: input.signature, updated_at: now,
  }).eq('id', app.id);
  if (error) return { ok: false, error: error.message };
  return { ok: true, signed_at: now };
}

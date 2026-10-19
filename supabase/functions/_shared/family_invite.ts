// =============================================================================
// family_invite.ts — text a family member a link to get the app (PLAN.md AZ)
// =============================================================================
// Doug, 10/19: "dad signs up... he wants the wife and kid to also have the
// app... a checkbox under each name adding a phone number... to text this
// family member a link". Adults and teens 13+ (the people who can also open
// the gate), by text only, ticked automatically on the signup form.
//
// Each invite is that person's own one-time sign-in link (7 days, like the
// welcome text's). After it expires they sign in with their number and a
// code, as anyone can. One link per person a day and a few per family a day,
// so a mistyped number can't be texted over and over.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const INVITE_ROLES = ['adult', 'teen'];
export const INVITE_LINK_DAYS = 7;
export const PER_FAMILY_PER_DAY = 6;
const DAY_MS = 86_400_000;

/** Can this family member be sent a link? Adults and teens with a phone. */
export function canInvite(m: { role?: unknown; phone_e164?: unknown; active?: unknown }): boolean {
  return m.active !== false && INVITE_ROLES.includes(String(m.role)) && !!m.phone_e164;
}

/** The text. Plain characters only (one curly quote doubles the cost). */
export function inviteText(a: { first: string; addedBy?: string | null; club: string; link: string }): string {
  const plain = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '').trim();
  const who = plain(a.addedBy || '');
  const first = plain(a.first) || 'there';
  return `Hi ${first}, ${who ? `${who} added you` : "you've been added"} to the ${plain(a.club)} app. `
    + `Tap to sign in, then add it to your Home Screen: ${a.link}`;
}

/** Why an invite can't go out right now, or null. */
export function inviteBlocked(a: { lastInvitedAt: string | null; familyToday: number; now: number }): string | null {
  if (a.lastInvitedAt && a.now - Date.parse(a.lastInvitedAt) < DAY_MS) return 'They were already sent a link today. They can also sign in with their number and a code.';
  if (a.familyToday >= PER_FAMILY_PER_DAY) return 'Your family has sent the most links for today. Try again tomorrow.';
  return null;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Text one family member their link. Never throws. */
export async function sendFamilyInvite(sb: SupabaseClient, args: {
  tenantId: string; memberId: string; addedBy?: string | null; source: string;
}): Promise<{ sent: boolean; error?: string }> {
  try {
    const { data: m } = await sb.from('household_members')
      .select('id, name, role, phone_e164, active, household_id, app_invited_at')
      .eq('id', args.memberId).eq('tenant_id', args.tenantId).maybeSingle();
    if (!m || !canInvite(m)) return { sent: false, error: 'Only adults and teens 13 and older with a mobile number can be sent a link.' };
    const { count } = await sb.from('household_members').select('id', { count: 'exact', head: true })
      .eq('household_id', m.household_id as string).gt('app_invited_at', new Date(Date.now() - DAY_MS).toISOString());
    const blocked = inviteBlocked({ lastInvitedAt: (m.app_invited_at as string | null) ?? null, familyToday: count ?? 0, now: Date.now() });
    if (blocked) return { sent: false, error: blocked };

    const { data: t } = await sb.from('tenants').select('slug, display_name').eq('id', args.tenantId).maybeSingle();
    if (!t) return { sent: false, error: 'Club not found.' };
    const tok = randomToken();
    await sb.from('member_magic_links').insert({
      tenant_id: args.tenantId, member_id: m.id,
      token_hash: await sha256Hex(tok),
      expires_at: new Date(Date.now() + INVITE_LINK_DAYS * DAY_MS).toISOString(),
    });
    const link = `https://${t.slug}.poolsideapp.com/m/verify.html#token=${encodeURIComponent(tok)}`;
    const first = String(m.name || '').trim().split(/\s+/)[0];
    const addedBy = String(args.addedBy || '').trim().split(/\s+/)[0] || null;
    const { sendSms } = await import('./send_sms.ts');
    const r = await sendSms({
      sb, tenantId: args.tenantId, to: m.phone_e164 as string,
      body: inviteText({ first, addedBy, club: String(t.display_name || 'club'), link }),
      kind: 'transactional', source: args.source,
    });
    if (!r.sent) return { sent: false, error: "The text didn't go through. They can still sign in with their number and a code." };
    await sb.from('household_members').update({ app_invited_at: new Date().toISOString() }).eq('id', m.id);
    return { sent: true };
  } catch (e) {
    console.error('family invite (non-fatal):', (e as Error).message);
    return { sent: false, error: "The text didn't go through. They can still sign in with their number and a code." };
  }
}

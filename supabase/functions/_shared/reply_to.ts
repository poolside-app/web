// Where a family's reply to a club email goes (PLAN.md BG5, Doug 10/20).
// Club emails come from Poolside's no-reply address but invite a reply
// ("Questions? Just reply to this email"), so every one carries a reply-to:
// the Club email on Settings → Club info, else the President (then the
// Vice-President, then any full-access login, the same fallback alerts use).

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { loadBoard } from './positions_db.ts';
import { noticeRecipients } from './positions.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function clubReplyTo(sb: SupabaseClient, tenantId: string, settingsValue?: Record<string, unknown> | null): Promise<string | undefined> {
  try {
    let v = settingsValue;
    if (v === undefined) {
      const { data } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
      v = (data?.value as Record<string, unknown> | null) ?? null;
    }
    const clubEmail = String(((v?.club as Record<string, unknown> | undefined)?.email) ?? '').trim();
    if (EMAIL_RE.test(clubEmail)) return clubEmail;
    // No position is told about this, so it falls back to the President.
    const b = await loadBoard(sb as never, tenantId);
    const ids = noticeRecipients('club_email_replies', b.positions as never, b.holders, b.logins as never);
    for (const id of ids) {
      const l = b.logins.find(x => x.id === id);
      if (l?.email && EMAIL_RE.test(String(l.email))) return String(l.email);
    }
  } catch { /* no reply-to: replies go to no-reply, as before */ }
  return undefined;
}

// Cancel a party: the board's Cancel on Parties, and the refund choice
// (PLAN.md BT4). Canceled, off the calendar, its party doors end, and its
// waiting to-dos close. Nothing is refunded here.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { endPartyPass } from './access.ts';

export async function cancelParty(
  sb: SupabaseClient, tenantId: string, id: string, by: string | null, adminNotes?: string | null,
): Promise<boolean> {
  const { data: bk } = await sb.from('party_bookings').select('id, event_id, admin_notes')
    .eq('id', id).eq('tenant_id', tenantId).maybeSingle();
  if (!bk) return false;
  const now = new Date().toISOString();
  await sb.from('party_bookings').update({
    status: 'cancelled',
    // Kept unless a new note is given (a select of just a few columns once
    // nulled the board's notes on cancel).
    admin_notes: adminNotes ?? (bk.admin_notes as string | null) ?? null,
    decided_at: now,
    decided_by: by,
    updated_at: now,
  }).eq('id', id).eq('tenant_id', tenantId);

  // No more party doors (PLAN.md AR5).
  await endPartyPass(sb, tenantId, id).catch(() => null);

  // An event already on the calendar is hidden.
  if (bk.event_id) {
    await sb.from('events').update({ active: false, updated_at: now })
      .eq('id', bk.event_id as string).eq('tenant_id', tenantId);
  }

  // Its waiting to-dos: the board already acted.
  await sb.from('admin_tasks').update({ completed_at: now, completed_by: by })
    .eq('tenant_id', tenantId).eq('source_kind', 'party_booking').eq('source_id', id)
    .in('kind', ['party.requested', 'party.venmo_claim']).is('completed_at', null);
  return true;
}

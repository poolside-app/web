// =============================================================================
// board_discount.ts — a board member's discount on their own family's dues
// =============================================================================
// PLAN.md CO, Doug 11/8: "when adding that board member, there should be a
// spot that has a check box allowing for a free membership? … Or have a
// discount apply right there?". The President sets each board member's
// discount on the Board page (admin_users.member_discount_pct: 0, 50, 100 or
// any percent). It comes off their family's dues, as long as they're on the
// board, found two ways only:
//   - their family has a member linked to their board login (PLAN.md CN),
//     which covers renewals;
//   - they started the signup from their board home ("Sign up your own
//     family"), which sends their board sign-in (applications.board_admin_id).
// Never from a phone number typed into the public form, so nobody can claim
// a board member's discount by typing their number.
// =============================================================================

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one

export async function boardDiscountFor(sb: Db, tenantId: string, args: {
  boardAdminId?: string | null; householdId?: string | null;
}): Promise<null | { pct: number; name: string; admin_id: string }> {
  try {
    const found: Array<Record<string, unknown>> = [];
    if (args.boardAdminId) {
      const { data } = await sb.from('admin_users').select('id, display_name, member_discount_pct, active')
        .eq('id', args.boardAdminId).eq('tenant_id', tenantId).eq('active', true).maybeSingle();
      if (data) found.push(data);
    }
    if (args.householdId) {
      const { data: people } = await sb.from('household_members').select('id')
        .eq('household_id', args.householdId).eq('tenant_id', tenantId).eq('active', true);
      const ids = ((people ?? []) as Array<{ id: string }>).map(p => p.id);
      if (ids.length) {
        const { data: admins } = await sb.from('admin_users').select('id, display_name, member_discount_pct, active')
          .eq('tenant_id', tenantId).eq('active', true).in('linked_member_id', ids);
        found.push(...((admins ?? []) as Array<Record<string, unknown>>));
      }
    }
    const best = found
      .map(a => ({ admin_id: String(a.id), name: String(a.display_name ?? 'Board member'), pct: Math.max(0, Math.min(100, Math.trunc(Number(a.member_discount_pct) || 0))) }))
      .filter(a => a.pct > 0)
      .sort((x, y) => y.pct - x.pct)[0];
    return best ?? null;
  } catch { return null; }   // never break a price over it
}

/** "Free", "Half off", "25% off": how the pages say it. */
export function boardDiscountLabel(pct: number): string {
  return pct >= 100 ? 'Free' : pct === 50 ? 'Half off' : `${pct}% off`;
}

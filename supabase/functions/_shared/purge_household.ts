// =============================================================================
// purge_household.ts — Delete for good (households_admin purge_household)
// =============================================================================
// HARD delete: the household, its people, its signups and everything tied to
// it. Doug 2026-05-23: soft-delete left rows visible in queries and in the
// duplicate-signup guards (phone/email collisions stuck around).
//
// PLAN.md BS1 (Doug 11/4, "fix the left overs"): it used to leave the family's
// keyfob to-do (the empty Keyfobs badge on 11/3) and its payment plan behind.
// Keyfobs, parties, help requests and passes go with the household by
// cascade, but their to-dos don't, and a plan only loses its household. So
// every id tied to the family is gathered first, while it can still be found.
// Every step is scoped by tenant so another club's rows are never touched.
// =============================================================================

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one
type Row = { id: string };
const idsOf = (r: { data: Row[] | null }) => (r.data ?? []).map(x => x.id);

export async function purgeHousehold(sb: Db, tid: string, id: string): Promise<
  { ok: true; family_name: string; members_removed: number; applications_removed: number; plans_removed: number; tasks_removed: number }
  | { ok: false; error: string; status: number }
> {
  const { data: hh } = await sb.from('households')
    .select('id, family_name').eq('id', id).eq('tenant_id', tid).maybeSingle();
  if (!hh) return { ok: false, error: 'Household not found', status: 404 };

  const [apps, fobs, parties, helps, plans, bookings] = await Promise.all(
    ['applications', 'keyfobs', 'party_bookings', 'help_requests', 'payment_plans', 'program_bookings'].map(t =>
      sb.from(t).select('id').eq('tenant_id', tid).eq('household_id', id)),
  );
  const appIds = idsOf(apps), planIds = idsOf(plans);
  // A refund on a plan payment is a to-do about that payment (PLAN.md BT8).
  const insts = planIds.length ? await sb.from('payment_plan_installments').select('id').in('plan_id', planIds) : { data: [] };

  // Every to-do about the family: its signups, keyfobs (one per fob, or the
  // family's), parties, plans and their payments, programs and help requests.
  const sources = [id, ...appIds, ...idsOf(fobs), ...idsOf(parties), ...idsOf(helps), ...planIds, ...idsOf(insts), ...idsOf(bookings)];
  const { data: tasks } = await sb.from('admin_tasks').select('id').eq('tenant_id', tid).in('source_id', sources);
  await sb.from('admin_tasks').delete().eq('tenant_id', tid).in('source_id', sources);

  if (appIds.length) {
    // Their waiting Drive backups too (PLAN.md Z1), or they retry forever.
    await sb.from('drive_sync_queue').delete().eq('tenant_id', tid).in('application_id', appIds);
    await sb.from('applications').delete().eq('tenant_id', tid).in('id', appIds);
  }
  if (planIds.length) {
    await sb.from('payment_plan_installments').delete().in('plan_id', planIds);
    await sb.from('payment_plans').delete().eq('tenant_id', tid).in('id', planIds);
  }
  // The auto-renew card consents.
  await sb.from('payment_authorizations').delete().eq('tenant_id', tid).eq('household_id', id);

  const { data: hm } = await sb.from('household_members').select('id').eq('household_id', id).eq('tenant_id', tid);
  const memberIds = (hm ?? []).map((r: Row) => r.id);
  if (memberIds.length) {
    await sb.from('member_sessions').delete().in('member_id', memberIds);
    await sb.from('member_magic_links').delete().in('member_id', memberIds);
  }
  await sb.from('household_members').delete().eq('household_id', id).eq('tenant_id', tid);
  const { error } = await sb.from('households').delete().eq('id', id).eq('tenant_id', tid);
  if (error) return { ok: false, error: error.message, status: 500 };

  return {
    ok: true, family_name: hh.family_name, members_removed: memberIds.length, applications_removed: appIds.length,
    plans_removed: planIds.length, tasks_removed: (tasks ?? []).length,
  };
}

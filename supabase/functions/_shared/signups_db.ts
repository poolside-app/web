// =============================================================================
// signups_db.ts — the sign-up steps that touch the database (PLAN.md BM)
// =============================================================================
// The daily run's part: once a shift is over, its poster gets one to-do to
// tick who came (that gives each their thank-you). A shift nobody signed up
// for just closes. Used by payment_plans' daily run and by the volunteer
// function's own cron action (tests run it for one club).
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { shiftEnded } from './signups.ts';
import { enqueueAdminTask } from './enqueue_task.ts';

export const signupLink = (oppId: string) => `/club/admin/volunteer.html#o=${oppId}`;

export async function askAttendance(sb: SupabaseClient, onlyTenant: string | null, nowIso = new Date().toISOString()):
  Promise<{ asked: number; closed: number }> {
  let q = sb.from('volunteer_opportunities')
    .select('id, tenant_id, kind, title, starts_at, ends_at, created_by, active, closed_at')
    .eq('kind', 'shift').eq('active', true).is('closed_at', null).is('attendance_asked_at', null)
    .lte('starts_at', nowIso).limit(200);
  if (onlyTenant) q = q.eq('tenant_id', onlyTenant);
  const { data } = await q;
  let asked = 0, closed = 0;
  for (const o of data ?? []) {
    if (!shiftEnded(o, nowIso)) continue;
    const { count } = await sb.from('volunteer_signups').select('id', { count: 'exact', head: true })
      .eq('opportunity_id', o.id).eq('status', 'confirmed');
    if (!count) {
      await sb.from('volunteer_opportunities').update({ closed_at: nowIso, attendance_asked_at: nowIso }).eq('id', o.id);
      closed++;
      continue;
    }
    await enqueueAdminTask(sb, {
      tenant_id: o.tenant_id as string, target_scopes: [], assigned_admin_id: (o.created_by as string | null) ?? null,
      kind: 'signup.attendance', summary: `Who came to "${o.title}"? Tick them for their thank-you.`,
      link_url: signupLink(o.id as string), source_kind: 'signup', source_id: o.id as string, skip_push: true,
    });
    await sb.from('volunteer_opportunities').update({ attendance_asked_at: nowIso }).eq('id', o.id);
    asked++;
  }
  return { asked, closed };
}

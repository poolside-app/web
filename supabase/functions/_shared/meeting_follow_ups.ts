// =============================================================================
// meeting_follow_ups — a closed meeting's follow-ups on the assignees' dashboards
// =============================================================================
// A follow-up assigned to someone on the board list (assigned_admin_id) goes
// on that board member's dashboard when the meeting closes, and stays there
// until it's marked done. Done in either place is done in both:
//   - board_meetings (finalize, amend) calls syncFollowUpTasks
//   - admin_tasks (complete) calls markFollowUpDone
// Follow-ups for people who aren't on the board are kept in the minutes only.
// Tasks point at the meeting (source_kind 'board_meeting', source_id) and
// name the follow-up in metadata.follow_up_id.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enqueueAdminTask } from './enqueue_task.ts';
import { isBoardMember } from './board.ts';

export type FollowUp = {
  id: string; description?: string | null; assigned_to?: string | null;
  assigned_admin_id?: string | null; due_date?: string | null; status?: string | null;
};
export type MeetingForTasks = {
  id: string; tenant_id: string; meeting_date: string; status: string;
  follow_ups_json?: FollowUp[] | null;
};

// "Sep 25" from a YYYY-MM-DD date. Dates are calendar days, not moments.
const shortDay = (key: string) =>
  new Date(`${key}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function followUpSummary(meetingDate: string, f: FollowUp): string {
  return `From the ${shortDay(meetingDate)} board meeting: ${f.description}${f.due_date ? ` (due ${shortDay(f.due_date)})` : ''}`;
}

/** The follow-ups that belong on a dashboard right now, by follow-up id. */
export function wantedFollowUpTasks(m: MeetingForTasks, boardIds: Set<string>): Map<string, FollowUp> {
  const out = new Map<string, FollowUp>();
  if (m.status !== 'completed') return out;
  for (const f of m.follow_ups_json ?? []) {
    if (f.status === 'open' && f.description && f.assigned_admin_id && boardIds.has(f.assigned_admin_id)) out.set(f.id, f);
  }
  return out;
}

/** Make the dashboards match the minutes. `actorId` is who made the change. */
export async function syncFollowUpTasks(sb: SupabaseClient, m: MeetingForTasks, actorId: string | null): Promise<void> {
  const { data: admins } = await sb.from('admin_users')
    .select('id, role_template, roles, active').eq('tenant_id', m.tenant_id).eq('active', true);
  const wanted = wantedFollowUpTasks(m, new Set((admins ?? []).filter(isBoardMember).map(a => a.id)));
  const statusOf = new Map((m.follow_ups_json ?? []).map(f => [f.id, f.status]));

  const { data: open } = await sb.from('admin_tasks').select('id, assigned_admin_id, summary, metadata')
    .eq('tenant_id', m.tenant_id).eq('source_kind', 'board_meeting').eq('source_id', m.id)
    .is('completed_at', null).is('dismissed_at', null);
  const now = new Date().toISOString();
  for (const t of open ?? []) {
    const fid = (t.metadata as Record<string, string> | null)?.follow_up_id;
    const f = fid ? wanted.get(fid) : undefined;
    if (f && f.assigned_admin_id === t.assigned_admin_id) {
      const summary = followUpSummary(m.meeting_date, f);
      if (summary !== t.summary) await sb.from('admin_tasks').update({ summary }).eq('id', t.id);
      wanted.delete(fid!);   // already on the right dashboard
      continue;
    }
    // Done in the minutes → done on the dashboard. Skipped, deleted or
    // handed to someone else → taken off it.
    const patch = fid && statusOf.get(fid) === 'done'
      ? { completed_at: now, completed_by: actorId }
      : { dismissed_at: now };
    await sb.from('admin_tasks').update(patch).eq('id', t.id);
  }

  for (const f of wanted.values()) {
    await enqueueAdminTask(sb, {
      tenant_id: m.tenant_id,
      target_scopes: [],
      assigned_admin_id: f.assigned_admin_id,
      kind: 'meeting.follow_up',
      summary: followUpSummary(m.meeting_date, f),
      link_url: `/club/admin/board-meetings.html#m=${m.id}`,
      source_kind: 'board_meeting', source_id: m.id,
      metadata: { follow_up_id: f.id },
      push_title: 'A board meeting follow-up for you',
      push_body: `${f.description}${f.due_date ? ` (due ${shortDay(f.due_date)})` : ''}`,
    });
  }
}

/** A follow-up's task was marked done on a dashboard: mark it done in the minutes. */
export async function markFollowUpDone(sb: SupabaseClient, tenantId: string, meetingId: string, followUpId: string): Promise<void> {
  const { data: m } = await sb.from('board_meetings').select('follow_ups_json')
    .eq('id', meetingId).eq('tenant_id', tenantId).maybeSingle();
  if (!m) return;
  const list = ((m.follow_ups_json ?? []) as FollowUp[])
    .map(f => f.id === followUpId ? { ...f, status: 'done' } : f);
  await sb.from('board_meetings').update({ follow_ups_json: list }).eq('id', meetingId).eq('tenant_id', tenantId);
}

/** A meeting was deleted: take its follow-ups off every dashboard. */
export async function clearFollowUpTasks(sb: SupabaseClient, tenantId: string, meetingId: string): Promise<void> {
  await sb.from('admin_tasks').update({ dismissed_at: new Date().toISOString() })
    .eq('tenant_id', tenantId).eq('source_kind', 'board_meeting').eq('source_id', meetingId)
    .is('completed_at', null).is('dismissed_at', null);
}

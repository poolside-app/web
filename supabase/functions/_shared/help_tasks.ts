// =============================================================================
// help_tasks — a help request's place on the board's dashboards
// =============================================================================
// While a request is unsolved it has one open admin_tasks row (source_kind
// 'help_request'), on the assignee's dashboard or the president's. Member
// replies pop up without adding a second task. Solving it completes the
// task; handing it off or deleting it dismisses it. Done on the dashboard
// marks the request solved (admin_tasks calls markHelpSolved).
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { enqueueAdminTask, pushBoard } from './enqueue_task.ts';
import { snippet, TOPIC_LABELS, type Topic } from './help.ts';

type Req = { id: string; tenant_id: string; topic: string; assigned_admin_id: string | null };

/** Put the request on its assignee's dashboard (the president's when no one
 *  handles the topic), unless it's already there — then just pop up. */
export async function openHelpTask(sb: SupabaseClient, req: Req, memberName: string, text: string, isReply: boolean): Promise<void> {
  const label = TOPIC_LABELS[req.topic as Topic] ?? 'Help';
  const url = `/club/admin/member-help.html#r=${req.id}`;
  const { data: open } = await sb.from('admin_tasks').select('id')
    .eq('tenant_id', req.tenant_id).eq('source_kind', 'help_request').eq('source_id', req.id)
    .is('completed_at', null).is('dismissed_at', null).limit(1);
  if (open && open.length) {
    await pushBoard({
      tenant_id: req.tenant_id, target_scopes: [], assigned_admin_id: req.assigned_admin_id,
      title: `${memberName} replied`, body: snippet(text, 120), url, tag: `help_request:${req.id}`,
    });
    return;
  }
  await enqueueAdminTask(sb, {
    tenant_id: req.tenant_id,
    target_scopes: [],                        // with no assignee: the president
    assigned_admin_id: req.assigned_admin_id,
    kind: 'help.request',
    summary: `${label}: ${memberName} - "${snippet(text, 70)}"`,
    link_url: url,
    source_kind: 'help_request', source_id: req.id,
    push_title: isReply ? `${memberName} replied` : `${label} question from ${memberName}`,
    push_body: snippet(text, 120),
  });
}

/** Take the request off dashboards: 'complete' when solved, 'dismiss' when
 *  it moved to someone else or was deleted. */
export async function closeHelpTasks(sb: SupabaseClient, tenantId: string, requestId: string, how: 'complete' | 'dismiss', adminId: string | null): Promise<void> {
  const now = new Date().toISOString();
  await sb.from('admin_tasks')
    .update(how === 'complete' ? { completed_at: now, completed_by: adminId } : { dismissed_at: now })
    .eq('tenant_id', tenantId).eq('source_kind', 'help_request').eq('source_id', requestId)
    .is('completed_at', null).is('dismissed_at', null);
}

/** Done on the dashboard = solved (admin_tasks calls this). */
export async function markHelpSolved(sb: SupabaseClient, tenantId: string, requestId: string, adminId: string | null): Promise<void> {
  const { data: req } = await sb.from('help_requests').select('id, status')
    .eq('id', requestId).eq('tenant_id', tenantId).maybeSingle();
  if (!req || req.status === 'solved') return;
  const now = new Date().toISOString();
  await sb.from('help_requests').update({ status: 'solved', solved_at: now, solved_by: adminId, updated_at: now })
    .eq('id', requestId).eq('tenant_id', tenantId);
  let who = 'a board member';
  if (adminId) {
    const { data: a } = await sb.from('admin_users').select('display_name').eq('id', adminId).maybeSingle();
    if (a?.display_name) who = a.display_name;
  }
  await sb.from('help_messages').insert({
    tenant_id: tenantId, request_id: requestId, author_kind: 'note', author_admin_id: adminId,
    body: `Marked solved from the dashboard by ${who}`,
  });
}

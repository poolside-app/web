// =============================================================================
// task_routing — who sees a dashboard task, and who gets its phone pop-up
// =============================================================================
// A task is for one of:
//   - one board member (assigned_admin_id): that person, plus the president
//     on the dashboard. The pop-up goes to that person only.
//   - anyone holding one of its permissions (target_scopes), plus the
//     president.
//   - the president only (no permissions, no assignee).
// "President" means an owner login. Owners always see every task.
// Tested offline by scripts/test_task_routing.mjs.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export type RoutedTask = { target_scopes?: string[] | null; assigned_admin_id?: string | null };
export type Caller = { id: string; isOwner: boolean; scopes: string[] };
export type BoardLogin = { id: string; role_template?: string | null; scopes?: string[] | null; active?: boolean | null };

export const isOwnerLogin = (a: BoardLogin) => (a.role_template ?? 'owner') === 'owner';

/** Does this board member see the task on their dashboard? */
export function taskVisibleTo(task: RoutedTask, caller: Caller): boolean {
  if (caller.isOwner) return true;
  if (task.assigned_admin_id) return task.assigned_admin_id === caller.id;
  const targets = task.target_scopes ?? [];
  return targets.some(s => caller.scopes.includes(s));
}

/** Which board logins get the phone pop-up. An assignee who has left the
 *  board (inactive or gone) hands it to the president. */
export function pushRecipients(
  admins: BoardLogin[],
  opts: { scopes?: string[] | null; assigned_admin_id?: string | null },
): string[] {
  const active = admins.filter(a => a.active !== false);
  if (opts.assigned_admin_id) {
    const who = active.find(a => a.id === opts.assigned_admin_id);
    if (who) return [who.id];
  }
  const scopes = opts.assigned_admin_id ? [] : (opts.scopes ?? []);
  return active
    .filter(a => isOwnerLogin(a) || scopes.some(s => (a.scopes ?? []).includes(s)))
    .map(a => a.id);
}

/** Help topics a member can pick. Each can be handed to one board member
 *  in Settings (settings.value.help_topics = { keyfob: <admin id>, … }). */
export const HELP_TOPICS = ['keyfob', 'membership', 'parties', 'facility'] as const;
export type HelpTopic = typeof HELP_TOPICS[number];

/** The active board member who handles a topic, or null (→ the president). */
export async function topicOwnerId(sb: SupabaseClient, tenantId: string, topic: HelpTopic): Promise<string | null> {
  const { data: s } = await sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle();
  const id = (s?.value as Record<string, Record<string, unknown>> | null)?.help_topics?.[topic];
  if (typeof id !== 'string' || !id) return null;
  const { data: a } = await sb.from('admin_users').select('id')
    .eq('id', id).eq('tenant_id', tenantId).eq('active', true).maybeSingle();
  return a?.id ?? null;
}

// =============================================================================
// task_routing — who sees a dashboard task, and who gets its phone pop-up
// =============================================================================
// A task is for one of:
//   - one board member (assigned_admin_id): that person, plus the president
//     on the dashboard. The pop-up goes to that person only.
//   - whoever holds the board position that gets its alert (PLAN.md K3,
//     positions.ts): the task's `notice`, or the alert its kind belongs to.
//     Worked out when shown, so reassigning a position moves its open tasks.
//   - anyone holding one of its permissions (target_scopes), plus the
//     president: tasks with no alert.
//   - the president only (no permissions, no assignee).
// "President" means an owner login. Owners always see every task.
// Tested offline by scripts/test_task_routing.mjs and test_positions.mjs.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { HELP_NOTICE, TASK_NOTICE } from './positions.ts';

export type RoutedTask = { target_scopes?: string[] | null; assigned_admin_id?: string | null; notice?: string | null; kind?: string | null };

/** The position alert a task belongs to, if any. */
export const taskNotice = (t: RoutedTask): string | null => t.notice ?? (t.kind ? TASK_NOTICE[t.kind] ?? null : null);
export type Caller = { id: string; isOwner: boolean; scopes: string[] };
export type BoardLogin = { id: string; role_template?: string | null; scopes?: string[] | null; active?: boolean | null };

export const isOwnerLogin = (a: BoardLogin) => (a.role_template ?? 'owner') === 'owner';

/** Does this board member see the task on their dashboard?
 *  `recipientsOf(notice)` is who gets a position alert now (positions_db). */
export function taskVisibleTo(task: RoutedTask, caller: Caller, recipientsOf?: (notice: string) => string[]): boolean {
  if (caller.isOwner) return true;
  if (task.assigned_admin_id) return task.assigned_admin_id === caller.id;
  const notice = taskNotice(task);
  if (notice && recipientsOf) return recipientsOf(notice).includes(caller.id);
  const targets = task.target_scopes ?? [];
  return targets.some(s => caller.scopes.includes(s));
}

/** Which board logins get the phone pop-up. An assignee who has left the
 *  board (inactive or gone) hands it to the president. */
export function pushRecipients(
  admins: BoardLogin[],
  opts: { scopes?: string[] | null; assigned_admin_id?: string | null; notice_recipients?: string[] | null; admin_ids?: string[] | null },
): string[] {
  const active = admins.filter(a => a.active !== false);
  // A named list, e.g. the whole board for a meeting agenda (PLAN.md L3).
  if (opts.admin_ids && opts.admin_ids.length) return active.filter(a => opts.admin_ids!.includes(a.id)).map(a => a.id);
  if (opts.assigned_admin_id) {
    const who = active.find(a => a.id === opts.assigned_admin_id);
    if (who) return [who.id];
  }
  // A position alert pops up for its holders only (the president sees it on
  // the dashboard, and gets the pop-up when the position is empty).
  if (opts.notice_recipients && opts.notice_recipients.length) {
    return active.filter(a => opts.notice_recipients!.includes(a.id)).map(a => a.id);
  }
  const scopes = opts.assigned_admin_id ? [] : (opts.scopes ?? []);
  return active
    .filter(a => isOwnerLogin(a) || scopes.some(s => (a.scopes ?? []).includes(s)))
    .map(a => a.id);
}

/** Help topics a member can pick (besides "something else"). Each goes to
 *  whoever holds the position that gets it (Board page, PLAN.md K3). */
export const HELP_TOPICS = ['keyfob', 'membership', 'parties', 'facility', 'grounds'] as const;
export type HelpTopic = typeof HELP_TOPICS[number] | 'other';

/** The board member who handles a help topic: the first holder of the
 *  position that gets it, else the President (positions.ts fallback). */
export async function topicOwnerId(sb: SupabaseClient, tenantId: string, topic: HelpTopic): Promise<string | null> {
  const { recipientsFor } = await import('./positions_db.ts');
  return (await recipientsFor(sb as never, tenantId, HELP_NOTICE[topic]))[0] ?? null;
}

// =============================================================================
// enqueue_task — write an admin_tasks row + fire a Web Push to subscribers
// =============================================================================
// Wraps the admin_tasks insert that several functions do so the push fan-out
// is a single function to maintain. Pushes are best-effort: if push_admin
// fails or VAPID isn't configured, the task still gets queued. The board
// member just won't get a phone buzz — they'll see it on the dashboard
// when they next log in.
//
// Push targeting: scopes from the task's target_scopes array. Owner-role
// admins get the push regardless (mirrors the dashboard scope check).
//
// Anti-spam: tag === source_kind:source_id, so a re-fired task for the
// same entity replaces the previous OS notification rather than stacking
// (e.g. a Venmo claim after the application.submitted task already fired
// shouldn't double-buzz the coordinator).
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

export type TaskInput = {
  tenant_id: string;
  target_scopes: string[];                  // e.g. ['applications', 'payments']
  kind: string;                             // 'application.submitted', 'venmo.claim', etc.
  summary: string;                          // human-readable for the queue UI
  link_url?: string;                        // dashboard deep-link
  source_kind?: string;
  source_id?: string;
  metadata?: Record<string, unknown>;
  // Push-only:
  push_title?: string;                      // notification title (defaults to summary)
  push_body?: string;                       // notification body
  push_url?: string;                        // notification click URL (defaults to link_url)
  skip_push?: boolean;                      // for tasks that don't need a buzz
};

export async function enqueueAdminTask(
  sb: SupabaseClient,
  input: TaskInput,
): Promise<{ task_id: string | null; pushed?: { sent: number; failed: number } | null }> {
  // 1. Insert the task row.
  let task_id: string | null = null;
  try {
    const { data } = await sb.from('admin_tasks').insert({
      tenant_id: input.tenant_id,
      target_scopes: input.target_scopes,
      kind: input.kind,
      summary: input.summary,
      link_url: input.link_url ?? null,
      source_kind: input.source_kind ?? null,
      source_id: input.source_id ?? null,
      metadata: input.metadata ?? null,
    }).select('id').single();
    task_id = data?.id ?? null;
  } catch (e) {
    console.error('enqueueAdminTask: insert failed', (e as Error).message);
    // Don't throw — caller's primary action shouldn't fail because the
    // task queue write failed.
    return { task_id: null };
  }

  // 2. Fire push (fire-and-forget; never block on it).
  if (input.skip_push) return { task_id, pushed: null };
  try {
    const tag = input.source_kind && input.source_id
      ? `${input.source_kind}:${input.source_id}`
      : input.kind;
    const r = await fetch(`${SUPABASE_URL}/functions/v1/push_admin`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${SERVICE_ROLE}`,
        'x-poolside-internal': SERVICE_ROLE,
      },
      body: JSON.stringify({
        action: 'send_scoped',
        tenant_id: input.tenant_id,
        scopes: input.target_scopes,
        title: input.push_title ?? input.summary,
        body: input.push_body ?? '',
        url: input.push_url ?? input.link_url ?? '/club/admin/',
        tag,
      }),
    });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      return { task_id, pushed: j ? { sent: j.sent ?? 0, failed: j.failed ?? 0 } : null };
    }
  } catch (e) {
    console.error('enqueueAdminTask: push fan-out failed', (e as Error).message);
  }
  return { task_id, pushed: null };
}

// =============================================================================
// admin_tasks — board-member task queue, scoped by role
// =============================================================================
// When a member submits an application or claims a Venmo payment, the
// system writes a task here. Anyone with a matching scope (or owner role)
// sees it on their dashboard. First admin to handle it closes it for
// everyone — no double-handling. A task with assigned_admin_id is for that
// one board member (and owners). Rules: _shared/task_routing.ts.
//
// Actions:
//   { action: 'list', include_completed? }
//     → { ok, tasks: [...], me }  — open tasks visible to caller, newest
//                                   first; assigned ones carry assigned_name
//
//   { action: 'count' }
//     → { ok, open: N }        — fast pill for the dashboard
//
//   { action: 'complete', id, note? }
//     → { ok }
//
//   { action: 'dismiss', id }
//     → { ok }
//
// Tasks are also created by other Edge Functions (applications, parties,
// etc.). They share a helper: `enqueueTask(...)` in those functions writes
// directly to admin_tasks via service-role client.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { taskVisibleTo, type Caller } from '../_shared/task_routing.ts';
import { markFollowUpDone } from '../_shared/meeting_follow_ups.ts';
import { markHelpSolved } from '../_shared/help_tasks.ts';
import { TOPIC_LABELS } from '../_shared/help.ts';
import { loadBoard } from '../_shared/positions_db.ts';
import { noticeRecipients, HELP_NOTICE, SPENDING_RULE } from '../_shared/positions.ts';
import { taskNotice } from '../_shared/task_routing.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}

type Payload = { sub: string; kind: string; tid: string; synthetic?: boolean };
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const FIELDS = 'id, tenant_id, target_scopes, assigned_admin_id, notice, kind, summary, link_url, source_kind, source_id, metadata, created_at, completed_at, completed_by, dismissed_at';

// Returns the caller's effective scopes + owner flag, sourced from the DB
// rather than the JWT (so role changes take effect immediately on next call).
async function getCaller(sb: ReturnType<typeof createClient>, payload: Payload): Promise<Caller> {
  if (payload.synthetic) return { id: payload.sub, isOwner: true, scopes: [] };
  const { data: user } = await sb.from('admin_users')
    .select('role_template, scopes, active')
    .eq('id', payload.sub).eq('tenant_id', payload.tid).maybeSingle();
  if (!user || !user.active) return { id: payload.sub, isOwner: false, scopes: [] };
  return {
    id: payload.sub,
    isOwner: (user.role_template ?? 'owner') === 'owner',
    scopes: (user.scopes ?? []) as string[],
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const tokRaw  = authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '';
  const payload = tokRaw ? await verifyTenantAdmin(tokRaw) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const caller = await getCaller(sb, payload);
  // Who gets each board-position alert right now (PLAN.md K3). Loaded once
  // per call; tasks are routed when they're shown, so a reassigned position
  // takes its open tasks with it.
  const board = await loadBoard(sb, TID);
  const recipientsOf = (notice: string) => noticeRecipients(notice, board.positions, board.holders, board.logins);
  const visible = (t: Parameters<typeof taskVisibleTo>[0]) => taskVisibleTo(t, caller, recipientsOf);

  if (action === 'list') {
    let q = sb.from('admin_tasks').select(FIELDS).eq('tenant_id', TID);
    if (!body.include_completed) {
      q = q.is('completed_at', null).is('dismissed_at', null);
    }
    q = q.order('created_at', { ascending: false }).limit(100);
    const { data, error } = await q;
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const tasks = (data ?? []).filter(visible);
    // "For the Treasurer": the position a board-position alert belongs to.
    for (const t of tasks as Record<string, unknown>[]) {
      const n = taskNotice(t as never);
      if (n && !t.assigned_admin_id) t.for_position = board.positions.find(p => (p.notices ?? []).includes(n))?.title ?? 'President';
    }
    // Name who each assigned task is for ("For you" / "For Kristin").
    const ids = [...new Set(tasks.map(t => t.assigned_admin_id).filter(Boolean))];
    if (ids.length) {
      const { data: who } = await sb.from('admin_users').select('id, display_name, email')
        .eq('tenant_id', TID).in('id', ids);
      const names = new Map((who ?? []).map(a => [a.id, a.display_name || a.email]));
      for (const t of tasks as Record<string, unknown>[]) {
        if (t.assigned_admin_id) t.assigned_name = names.get(t.assigned_admin_id as string) ?? null;
      }
    }
    // For the dashboard: the member-help topics that come to this board
    // member, and how many of their devices get pop-ups. Pop-ups are the
    // only alert for help requests, so a topic owner with none hears nothing.
    const { count: devices } = await sb.from('admin_push_subscriptions').select('id', { count: 'exact', head: true })
      .eq('tenant_id', TID).eq('admin_user_id', caller.id);
    // The member help topics that come to this person through their position.
    const help_topics_mine = (Object.keys(TOPIC_LABELS) as (keyof typeof TOPIC_LABELS)[])
      .filter(t => recipientsOf(HELP_NOTICE[t]).includes(caller.id))
      .map(t => TOPIC_LABELS[t]);
    // "Your job" (PLAN.md K4): the positions this person holds, with their
    // job descriptions, and the club's spending rule.
    const heldIds = new Set(board.holders.filter(h => h.admin_user_id === caller.id).map(h => h.position_id));
    const my_positions = board.positions.filter(p => heldIds.has(p.id))
      .map(p => ({ title: p.title, purpose: p.purpose ?? null, description: p.description ?? null }));
    const { data: st } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const rule = ((st?.value as Record<string, Record<string, unknown>> | null)?.board?.spending_rule);
    return jsonResponse({
      ok: true, tasks, me: caller.id, help_topics_mine, push_devices: devices ?? 0,
      my_positions, spending_rule: typeof rule === 'string' ? rule : SPENDING_RULE,
    });
  }

  if (action === 'count') {
    const { data, error } = await sb.from('admin_tasks').select('id, target_scopes, assigned_admin_id, notice, kind')
      .eq('tenant_id', TID).is('completed_at', null).is('dismissed_at', null);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const open = (data ?? []).filter(visible).length;
    return jsonResponse({ ok: true, open });
  }

  if (action === 'complete') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: task } = await sb.from('admin_tasks').select('id, target_scopes, assigned_admin_id, notice, completed_at, kind, source_id, metadata')
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!task) return jsonResponse({ ok: false, error: 'Task not found' }, 404);
    if (!visible(task)) {
      return jsonResponse({ ok: false, error: 'Not your scope' }, 403);
    }
    if (task.completed_at) return jsonResponse({ ok: true });
    const { error } = await sb.from('admin_tasks')
      .update({ completed_at: new Date().toISOString(), completed_by: payload.synthetic ? null : payload.sub })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    // A meeting follow-up done here is done in the minutes too.
    const fid = (task.metadata as Record<string, string> | null)?.follow_up_id;
    if (task.kind === 'meeting.follow_up' && task.source_id && fid) {
      await markFollowUpDone(sb, TID, task.source_id, fid);
    }
    // A member help request marked done here is solved.
    if (task.kind === 'help.request' && task.source_id) {
      await markHelpSolved(sb, TID, task.source_id, payload.synthetic ? null : payload.sub);
    }
    return jsonResponse({ ok: true });
  }

  if (action === 'dismiss') {
    const id = String(body.id ?? '');
    if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
    const { data: task } = await sb.from('admin_tasks').select('id, target_scopes, assigned_admin_id, notice, kind, dismissed_at')
      .eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!task) return jsonResponse({ ok: false, error: 'Task not found' }, 404);
    if (!visible(task)) {
      return jsonResponse({ ok: false, error: 'Not your scope' }, 403);
    }
    if (task.dismissed_at) return jsonResponse({ ok: true });
    const { error } = await sb.from('admin_tasks')
      .update({ dismissed_at: new Date().toISOString() })
      .eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

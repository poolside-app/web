// =============================================================================
// board — the club's board positions (PLAN.md K)
// =============================================================================
// Doug, 2026-10-04: each club keeps its own board positions with job
// descriptions, editable at setup and any time after. A position decides its
// holder's screens and alerts (it replaced the fixed roles). One person can
// hold several; a position can have several holders.
//
// Any board member can read the positions and job descriptions. Only the
// president (a full-access login) changes them.
//
// Actions (tenant admin JWT; gate iPad logins are not board members):
//   { action: 'get' }                     → positions, holders, board members, lifeguard logins, catalogs
//   { action: 'mine' }                    → the caller's own positions (the "My job" card)
//   { action: 'save_position', position } → create or change one        (president)
//   { action: 'delete_position', id }     → only when nobody holds it    (president)
//   { action: 'reorder', ids }            → the order positions show in  (president)
//   { action: 'set_holders', position_id, admin_ids } → who holds it     (president)
//   { action: 'set_spending_rule', text }                                 (president)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { boardCaller, type BoardCaller } from '../_shared/board.ts';
import { NOTICES, SCREENS, HELP_NOTICE, SPENDING_RULE, loginFromPositions, noticeRecipients, slugify } from '../_shared/positions.ts';
import { loadBoard, syncLogins, POSITION_FIELDS } from '../_shared/positions_db.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type Payload = { sub: string; kind: string; tid: string; synthetic?: boolean };
async function verifyTenantAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const text = (v: unknown, max: number) => {
  const s = String(v ?? '').replace(/\r\n/g, '\n').trim();
  return s ? s.slice(0, max) : null;
};
const isFull = (a: { role_template?: string | null; roles?: string[] | null }) =>
  (a.role_template ?? 'owner') === 'owner' || (a.roles ?? []).includes('owner');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  const hdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const payload = hdr.startsWith('Bearer ') ? await verifyTenantAdmin(hdr.slice(7)) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const me: BoardCaller | null = payload.synthetic
    ? { id: payload.sub, isOwner: true, name: 'Poolside' }
    : await boardCaller(sb, payload.sub, payload.tid);
  if (!me) return jsonResponse({ ok: false, error: 'The board page is for board members.' }, 403);
  const TID = payload.tid;
  const onlyPresident = () => jsonResponse({ ok: false, error: 'Only the president can change board positions.' }, 403);

  async function audit(kind: string, summary: string, entityId: string | null = null, metadata: Record<string, unknown> = {}) {
    try {
      await sb.from('audit_log').insert({
        tenant_id: TID, kind, entity_type: 'board_position', entity_id: entityId, summary,
        actor_id: payload!.synthetic ? null : me!.id, actor_kind: 'tenant_admin', metadata,
      });
    } catch { /* never block a change on the audit write */ }
  }
  async function spendingRule(): Promise<string> {
    const { data } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const r = ((data?.value as Record<string, Record<string, unknown>> | null)?.board?.spending_rule);
    return typeof r === 'string' ? r : SPENDING_RULE;
  }

  // ── get ────────────────────────────────────────────────────────────────
  if (action === 'get') {
    const b = await loadBoard(sb, TID);
    const nameOf = (id: string) => {
      const l = b.logins.find(x => x.id === id);
      return (l?.display_name || (l as { email?: string } | undefined)?.email || 'Board member') as string;
    };
    const positions = b.positions.map(p => {
      const holders = b.holders.filter(h => h.position_id === p.id)
        .map(h => b.logins.find(l => l.id === h.admin_user_id)).filter(l => l && l.active !== false)
        .map(l => ({ id: l!.id, name: nameOf(l!.id), pending: !(l as { last_login_at?: string | null }).last_login_at }));
      // Where this position's alerts go while it's empty.
      const goesTo = holders.length ? null
        : (p.notices ?? []).length ? noticeRecipients((p.notices ?? [])[0], b.positions, b.holders, b.logins).map(nameOf) : null;
      return { ...p, holders, vacant_goes_to: goesTo };
    });
    const members = b.logins.filter(l => l.active !== false).map(l => ({
      id: l.id, name: nameOf(l.id), board_title: l.board_title ?? null,
      pending: !(l as { last_login_at?: string | null }).last_login_at,
      full_access: isFull(l),
      position_ids: b.holders.filter(h => h.admin_user_id === l.id).map(h => h.position_id),
    }));
    // Lifeguard and gate-iPad logins: not board members, made here too.
    const { data: staffRows } = await sb.from('admin_users').select('id, display_name, email, last_login_at')
      .eq('tenant_id', TID).eq('active', true).eq('role_template', 'gate_attendant').order('created_at');
    const staff = (staffRows ?? []).map(l => ({ id: l.id, name: l.display_name || l.email || 'Lifeguard', pending: !l.last_login_at }));
    return jsonResponse({
      ok: true, me: me.id, is_owner: me.isOwner,
      spending_rule: await spendingRule(),
      positions, members, staff,
      notices: Object.fromEntries(Object.entries(NOTICES).map(([k, v]) => [k, v.label])),
      screens: SCREENS,
    });
  }

  // ── mine — the "My job" card ───────────────────────────────────────────
  if (action === 'mine') {
    const { data: held } = await sb.from('board_position_holders').select('position_id')
      .eq('tenant_id', TID).eq('admin_user_id', me.id);
    const ids = (held ?? []).map(h => h.position_id);
    const { data: positions } = ids.length
      ? await sb.from('board_positions').select('id, title, purpose, description, sort').in('id', ids).order('sort')
      : { data: [] };
    return jsonResponse({ ok: true, positions: positions ?? [], spending_rule: await spendingRule() });
  }

  if (!me.isOwner) return onlyPresident();

  // ── save_position ──────────────────────────────────────────────────────
  if (action === 'save_position') {
    const p = (body.position ?? {}) as Record<string, unknown>;
    const title = text(p.title, 80);
    if (!title) return jsonResponse({ ok: false, error: 'A position needs a title.' }, 400);
    const row = {
      title,
      purpose: text(p.purpose, 400),
      description: text(p.description, 8000),
      notices: [...new Set((Array.isArray(p.notices) ? p.notices : []).map(String).filter(n => NOTICES[n]))],
      scopes: [...new Set((Array.isArray(p.scopes) ? p.scopes : []).map(String).filter(s => SCREENS[s]))],
      full_access: p.full_access === true,
      updated_at: new Date().toISOString(),
    };
    const b = await loadBoard(sb, TID);

    if (p.id) {
      const before = b.positions.find(x => x.id === String(p.id));
      if (!before) return jsonResponse({ ok: false, error: 'Position not found' }, 404);
      const holderIds = b.holders.filter(h => h.position_id === before.id).map(h => h.admin_user_id);
      // Taking full access off a position can't leave the club with nobody
      // who has it.
      if (before.full_access && !row.full_access && holderIds.length) {
        const after = { ...b, positions: b.positions.map(x => x.id === before.id ? { ...x, ...row } : x) };
        if (!keepsFullAccess(after, holderIds)) {
          return jsonResponse({ ok: false, error: 'Someone has to keep full access. Give another position full access first.' }, 409);
        }
      }
      const { data, error } = await sb.from('board_positions').update(row)
        .eq('id', before.id).eq('tenant_id', TID).select(POSITION_FIELDS).single();
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      await syncLogins(sb, TID, holderIds);
      await audit('board_position.updated', `Changed the ${title} position`, before.id, { before, after: row });
      return jsonResponse({ ok: true, position: data });
    }

    let slug = slugify(title);
    const taken = new Set(b.positions.map(x => x.slug));
    for (let i = 2; taken.has(slug); i++) slug = `${slugify(title)}_${i}`;
    const sort = b.positions.reduce((m, x) => Math.max(m, Number(x.sort) || 0), -1) + 1;
    const { data, error } = await sb.from('board_positions')
      .insert({ ...row, tenant_id: TID, slug, sort }).select(POSITION_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await audit('board_position.created', `Added the ${title} position`, data.id);
    return jsonResponse({ ok: true, position: data });
  }

  // ── delete_position ────────────────────────────────────────────────────
  if (action === 'delete_position') {
    const id = String(body.id ?? '');
    const { data: pos } = await sb.from('board_positions').select('id, title').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!pos) return jsonResponse({ ok: false, error: 'Position not found' }, 404);
    const { count } = await sb.from('board_position_holders').select('admin_user_id', { count: 'exact', head: true }).eq('position_id', id);
    if (count) return jsonResponse({ ok: false, error: `Take everyone out of ${pos.title} first.` }, 409);
    await sb.from('board_positions').delete().eq('id', id).eq('tenant_id', TID);
    await audit('board_position.deleted', `Removed the ${pos.title} position`, id);
    return jsonResponse({ ok: true });
  }

  // ── reorder ────────────────────────────────────────────────────────────
  if (action === 'reorder') {
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String);
    for (const [i, id] of ids.entries()) {
      await sb.from('board_positions').update({ sort: i }).eq('id', id).eq('tenant_id', TID);
    }
    return jsonResponse({ ok: true });
  }

  // ── set_holders ────────────────────────────────────────────────────────
  if (action === 'set_holders') {
    const positionId = String(body.position_id ?? '');
    const b = await loadBoard(sb, TID);
    const pos = b.positions.find(p => p.id === positionId);
    if (!pos) return jsonResponse({ ok: false, error: 'Position not found' }, 404);
    const wanted = [...new Set((Array.isArray(body.admin_ids) ? body.admin_ids : []).map(String))];
    const board = new Map(b.logins.filter(l => l.active !== false).map(l => [l.id, l]));
    const bad = wanted.find(id => !board.has(id));
    if (bad) return jsonResponse({ ok: false, error: 'Only active board members can hold a position.' }, 400);

    const before = b.holders.filter(h => h.position_id === positionId).map(h => h.admin_user_id);
    const added = wanted.filter(id => !before.includes(id));
    const removed = before.filter(id => !wanted.includes(id));
    if (!added.length && !removed.length) return jsonResponse({ ok: true, unchanged: true });

    // There always has to be someone with full access.
    const after = { ...b, holders: [...b.holders.filter(h => h.position_id !== positionId), ...wanted.map(id => ({ position_id: positionId, admin_user_id: id }))] };
    if (!keepsFullAccess(after, [...added, ...removed])) {
      return jsonResponse({ ok: false, error: 'Someone has to keep full access. Make someone else President first.' }, 409);
    }

    if (removed.length) await sb.from('board_position_holders').delete().eq('position_id', positionId).in('admin_user_id', removed);
    if (added.length) {
      await sb.from('board_position_holders').insert(added.map(id => ({ position_id: positionId, admin_user_id: id, tenant_id: TID })));
    }
    await syncLogins(sb, TID, [...added, ...removed]);

    // Open member help conversations on this position's topics move to
    // whoever handles them now. Other alerts follow the position by
    // themselves, since they're routed when they're shown.
    if (removed.length) {
      const topics = Object.entries(HELP_NOTICE).filter(([, n]) => (pos.notices ?? []).includes(n)).map(([t]) => t);
      if (topics.length) {
        const fresh = await loadBoard(sb, TID);
        const { data: open } = await sb.from('help_requests').select('id, topic, assigned_admin_id')
          .eq('tenant_id', TID).neq('status', 'solved').in('topic', topics).in('assigned_admin_id', removed);
        for (const r of open ?? []) {
          const to = noticeRecipients(HELP_NOTICE[r.topic as string], fresh.positions, fresh.holders, fresh.logins)[0] ?? null;
          await sb.from('help_requests').update({ assigned_admin_id: to }).eq('id', r.id);
          await sb.from('admin_tasks').update({ assigned_admin_id: to })
            .eq('tenant_id', TID).eq('source_kind', 'help_request').eq('source_id', r.id).is('completed_at', null);
        }
      }
    }

    const names = (ids: string[]) => ids.map(id => board.get(id)?.display_name || 'someone').join(', ');
    await audit('board_position.holders', [
      added.length ? `${names(added)} now ${added.length === 1 ? 'holds' : 'hold'} ${pos.title}` : '',
      removed.length ? `${names(removed)} no longer ${removed.length === 1 ? 'holds' : 'hold'} ${pos.title}` : '',
    ].filter(Boolean).join('; '), positionId, { added, removed });
    return jsonResponse({ ok: true, added, removed });
  }

  // ── set_spending_rule ──────────────────────────────────────────────────
  if (action === 'set_spending_rule') {
    const rule = text(body.text, 600) ?? '';
    const { data: s } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const value = (s?.value ?? {}) as Record<string, unknown>;
    const boardSettings = { ...((value.board as Record<string, unknown>) ?? {}), spending_rule: rule };
    if (s) await sb.from('settings').update({ value: { ...value, board: boardSettings } }).eq('tenant_id', TID);
    else await sb.from('settings').insert({ tenant_id: TID, value: { board: boardSettings } });
    await audit('board.spending_rule', `Changed the spending rule: ${rule.slice(0, 120)}`);
    return jsonResponse({ ok: true, spending_rule: rule });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

/** After a change, does at least one active board member still have full
 *  access? `changed` are the people whose positions changed: their access
 *  comes from their positions; everyone else keeps what they have. */
function keepsFullAccess(b: Awaited<ReturnType<typeof loadBoard>>, changed: string[]): boolean {
  return b.logins.filter(l => l.active !== false).some(l => {
    if (!changed.includes(l.id)) return isFull(l);
    const held = b.positions.filter(p => b.holders.some(h => h.position_id === p.id && h.admin_user_id === l.id));
    return held.length ? loginFromPositions(held).role_template === 'owner' : false;
  });
}

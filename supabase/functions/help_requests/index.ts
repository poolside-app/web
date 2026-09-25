// =============================================================================
// help_requests — members ask the board for help, the board answers
// =============================================================================
// Doug, 2026-09-25: "a keyfob issue goes to the keyfob person, a membership
// question goes to the membership board member … it tracks and items don't
// get left behind." Rules are in _shared/help.ts; dashboard tasks in
// _shared/help_tasks.ts. Tested by scripts/test_help_requests.mjs.
//
// Member actions (member token):
//   { action: 'submit', topic, body, photo_content_type?, photo_base64? }
//     → { ok, request }       // goes to the topic's board member or president
//   { action: 'mine' }        → { ok, requests }   // newest first
//   { action: 'get', id }     → { ok, request, messages }
//   { action: 'reply', id, body, photo_content_type?, photo_base64? }
//     → { ok, request }       // reopens a solved request
//
// Board actions (board member token; the assignee and the president only):
//   { action: 'list', view: 'open' | 'solved' | 'all' } → { ok, requests }
//   { action: 'get', id }     → { ok, request, messages, member }
//   { action: 'reply', id, body } → { ok, request, message }
//                               // texted to the member (email if no cell)
//   { action: 'set_status', id, status: 'open' | 'in_progress' | 'solved' }
//   { action: 'assign', id, admin_id | null }   // null = the president
//   { action: 'topics' }      → { ok, topics, board, mine }
//   { action: 'set_topics', topics: { keyfob: admin_id | null, … } } (president)
//   { action: 'delete', id }  (president; removes its photos)
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { boardCaller, isBoardMember, type BoardCaller } from '../_shared/board.ts';
import { HELP_TOPICS, topicOwnerId } from '../_shared/task_routing.ts';
import { TOPIC_LABELS, isTopic, helpLink, replyText, canSeeHelpRequest, snippet, type Topic } from '../_shared/help.ts';
import { openHelpTask, closeHelpTasks } from '../_shared/help_tasks.ts';
import { sendSms } from '../_shared/send_sms.ts';
import { sendEmail, emailShell, escHtml } from '../_shared/send_email.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type Payload = { sub: string; kind: string; tid: string; synthetic?: boolean };
async function verifyToken(token: string): Promise<Payload | null> {
  if (!JWT_SECRET || !token) return null;
  try {
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
    );
    const p = await verify(token, key) as Record<string, unknown>;
    if (!p.sub || !p.tid || (p.kind !== 'member' && p.kind !== 'tenant_admin')) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const BUCKET = 'help-photos';
const MAX_BODY = 2000;
const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const REQ_FIELDS = 'id, tenant_id, household_id, member_id, topic, status, assigned_admin_id, created_at, updated_at, solved_at';

function cleanBody(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, MAX_BODY) : null;
}

/** Store an optional photo privately. Returns its path, or an error to show. */
async function savePhoto(sb: SupabaseClient, tid: string, requestId: string, body: Record<string, unknown>): Promise<{ path?: string | null; error?: string }> {
  const ct = String(body.photo_content_type ?? '').trim();
  const b64 = String(body.photo_base64 ?? '');
  if (!ct || !b64) return { path: null };
  const ext = PHOTO_TYPES[ct];
  if (!ext) return { error: 'Photos must be JPG, PNG, WebP or GIF.' };
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return { error: 'That photo could not be read.' }; }
  if (bytes.byteLength > 8 * 1024 * 1024) return { error: 'That photo is too big (8 MB at most).' };
  const path = `${tid}/${requestId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: ct, upsert: false });
  if (error) return { error: 'The photo could not be saved. Try again, or send without it.' };
  return { path };
}

/** The conversation, with names and short-lived photo links. */
async function loadMessages(sb: SupabaseClient, requestId: string) {
  const { data: msgs } = await sb.from('help_messages')
    .select('id, author_kind, author_member_id, author_admin_id, body, photo_path, sent_by, send_error, created_at')
    .eq('request_id', requestId).order('created_at', { ascending: true });
  const list = msgs ?? [];
  const memberIds = [...new Set(list.map(m => m.author_member_id).filter(Boolean))] as string[];
  const adminIds = [...new Set(list.map(m => m.author_admin_id).filter(Boolean))] as string[];
  const [mem, adm] = await Promise.all([
    memberIds.length ? sb.from('household_members').select('id, name').in('id', memberIds) : Promise.resolve({ data: [] }),
    adminIds.length ? sb.from('admin_users').select('id, display_name, email').in('id', adminIds) : Promise.resolve({ data: [] }),
  ]);
  const names = new Map<string, string>();
  for (const m of (mem.data ?? []) as { id: string; name: string }[]) names.set(m.id, m.name);
  for (const a of (adm.data ?? []) as { id: string; display_name: string | null; email: string | null }[]) names.set(a.id, a.display_name || a.email || 'Board member');
  const paths = list.map(m => m.photo_path).filter(Boolean) as string[];
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data: signed } = await sb.storage.from(BUCKET).createSignedUrls(paths, 3600);
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls.set(s.path, s.signedUrl);
  }
  return list.map(m => ({
    id: m.id,
    author_kind: m.author_kind,
    author_name: names.get((m.author_member_id || m.author_admin_id) as string) ?? null,
    body: m.body,
    photo_url: m.photo_path ? urls.get(m.photo_path) ?? null : null,
    sent_by: m.sent_by,
    send_error: m.send_error,
    created_at: m.created_at,
  }));
}

async function adminName(sb: SupabaseClient, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { data } = await sb.from('admin_users').select('display_name, email').eq('id', id).maybeSingle();
  return data ? (data.display_name || data.email) : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return j({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const payload = await verifyToken(authHdr.startsWith('Bearer ') ? authHdr.slice(7) : '');
  if (!payload) return j({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;
  const { data: tenant } = await sb.from('tenants').select('id, slug, display_name, plan').eq('id', TID).maybeSingle();
  if (!tenant) return j({ ok: false, error: 'Club not found' }, 404);

  // ═══ Member side ═════════════════════════════════════════════════════
  if (payload.kind === 'member') {
    const { data: me } = await sb.from('household_members')
      .select('id, name, household_id, tenant_id, active')
      .eq('id', payload.sub).eq('tenant_id', TID).maybeSingle();
    if (!me || me.active === false) return j({ ok: false, error: 'Your membership isn\'t active.' }, 403);

    const shape = async (r: Record<string, unknown>) => ({
      id: r.id, topic: r.topic, topic_label: TOPIC_LABELS[r.topic as Topic], status: r.status,
      assigned_name: await adminName(sb, r.assigned_admin_id as string | null),
      created_at: r.created_at, updated_at: r.updated_at,
    });
    const ownRequest = async (id: string) => {
      if (!id) return null;
      const { data } = await sb.from('help_requests').select(REQ_FIELDS)
        .eq('id', id).eq('tenant_id', TID).eq('member_id', me.id).maybeSingle();
      return data;
    };

    if (action === 'submit') {
      const topic = String(body.topic ?? '');
      if (!isTopic(topic)) return j({ ok: false, error: 'Pick what your question is about.' }, 400);
      const text = cleanBody(body.body);
      if (!text) return j({ ok: false, error: 'Write a short message for the board.' }, 400);
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { count } = await sb.from('help_requests').select('id', { count: 'exact', head: true })
        .eq('member_id', me.id).gte('created_at', since);
      if ((count ?? 0) >= 10) return j({ ok: false, error: 'You\'ve sent a lot of requests today. Reply to one you already have, or try tomorrow.' }, 429);

      const id = crypto.randomUUID();
      const photo = await savePhoto(sb, TID, id, body);
      if (photo.error) return j({ ok: false, error: photo.error }, 400);
      const assigned = topic === 'other' ? null : await topicOwnerId(sb, TID, topic as typeof HELP_TOPICS[number]);
      const { data: r, error } = await sb.from('help_requests').insert({
        id, tenant_id: TID, household_id: me.household_id, member_id: me.id, topic, assigned_admin_id: assigned,
      }).select(REQ_FIELDS).single();
      if (error) return j({ ok: false, error: error.message }, 500);
      await sb.from('help_messages').insert({
        tenant_id: TID, request_id: id, author_kind: 'member', author_member_id: me.id, body: text, photo_path: photo.path,
      });
      await openHelpTask(sb, r, me.name, text, false);
      return j({ ok: true, request: await shape(r) });
    }

    if (action === 'mine') {
      const { data } = await sb.from('help_requests').select(REQ_FIELDS)
        .eq('tenant_id', TID).eq('member_id', me.id).order('updated_at', { ascending: false }).limit(50);
      const rows = data ?? [];
      const ids = rows.map(r => r.id);
      const last = new Map<string, { author_kind: string; body: string }>();
      if (ids.length) {
        const { data: msgs } = await sb.from('help_messages').select('request_id, author_kind, body, created_at')
          .in('request_id', ids).neq('author_kind', 'note').order('created_at', { ascending: true });
        for (const m of msgs ?? []) last.set(m.request_id, m);
      }
      const requests = [];
      for (const r of rows) {
        const l = last.get(r.id);
        requests.push({ ...(await shape(r)), last_from_board: l?.author_kind === 'board', last_snippet: l ? snippet(l.body, 90) : '' });
      }
      return j({ ok: true, requests });
    }

    if (action === 'get') {
      const r = await ownRequest(String(body.id ?? ''));
      if (!r) return j({ ok: false, error: 'Request not found' }, 404);
      return j({ ok: true, request: await shape(r), messages: await loadMessages(sb, r.id) });
    }

    if (action === 'reply') {
      const r = await ownRequest(String(body.id ?? ''));
      if (!r) return j({ ok: false, error: 'Request not found' }, 404);
      const text = cleanBody(body.body);
      if (!text) return j({ ok: false, error: 'Write a message first.' }, 400);
      const photo = await savePhoto(sb, TID, r.id, body);
      if (photo.error) return j({ ok: false, error: photo.error }, 400);
      await sb.from('help_messages').insert({
        tenant_id: TID, request_id: r.id, author_kind: 'member', author_member_id: me.id, body: text, photo_path: photo.path,
      });
      // A reply to a solved request means it isn't solved.
      const now = new Date().toISOString();
      const patch: Record<string, unknown> = { updated_at: now };
      if (r.status === 'solved') Object.assign(patch, { status: 'open', solved_at: null, solved_by: null });
      const { data: updated } = await sb.from('help_requests').update(patch).eq('id', r.id).select(REQ_FIELDS).single();
      await openHelpTask(sb, updated ?? r, me.name, text, true);
      return j({ ok: true, request: await shape(updated ?? r) });
    }

    return j({ ok: false, error: `Unknown action: ${action}` }, 400);
  }

  // ═══ Board side ══════════════════════════════════════════════════════
  const me: BoardCaller | null = await boardCaller(sb, payload.sub, TID);
  if (!me) return j({ ok: false, error: 'Member help is for board members only.' }, 403);

  // Board members for names, hand-offs and the topic picker.
  const { data: admins } = await sb.from('admin_users')
    .select('id, display_name, email, board_title, role_template, roles, active')
    .eq('tenant_id', TID).eq('active', true).order('display_name');
  const board = (admins ?? []).filter(isBoardMember).map(a => ({
    id: a.id, name: a.display_name || a.email, board_title: a.board_title || null,
    is_owner: (a.role_template ?? 'owner') === 'owner',
  }));
  const nameOf = (id: string | null) => id ? board.find(b => b.id === id)?.name ?? null : null;

  const visible = async (id: string) => {
    if (!id) return null;
    const { data } = await sb.from('help_requests').select(REQ_FIELDS).eq('id', id).eq('tenant_id', TID).maybeSingle();
    return data && canSeeHelpRequest(data, me) ? data : null;
  };
  const note = (requestId: string, text: string) => sb.from('help_messages').insert({
    tenant_id: TID, request_id: requestId, author_kind: 'note', author_admin_id: me.id, body: text,
  });
  const memberOf = async (r: { member_id: string | null; household_id: string | null }) => {
    const [{ data: m }, { data: h }] = await Promise.all([
      r.member_id ? sb.from('household_members').select('id, name, phone_e164, email').eq('id', r.member_id).maybeSingle() : Promise.resolve({ data: null }),
      r.household_id ? sb.from('households').select('family_name').eq('id', r.household_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    return { name: m?.name ?? 'A member', family_name: h?.family_name ?? null, phone: m?.phone_e164 ?? null, email: m?.email ?? null };
  };
  const shapeBoard = (r: Record<string, unknown>) => ({
    ...r, topic_label: TOPIC_LABELS[r.topic as Topic], assigned_name: nameOf(r.assigned_admin_id as string | null),
  });

  if (action === 'topics') {
    const { data: s } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const saved = ((s?.value as Record<string, unknown> | null)?.help_topics ?? {}) as Record<string, string | null>;
    const topics: Record<string, { admin_id: string; name: string } | null> = {};
    for (const t of HELP_TOPICS) {
      const id = saved[t];
      const b = id ? board.find(x => x.id === id) : undefined;
      topics[t] = b ? { admin_id: b.id, name: b.name } : null;
    }
    const mine = HELP_TOPICS.filter(t => topics[t]?.admin_id === me.id);
    return j({ ok: true, topics, labels: TOPIC_LABELS, board, mine, is_owner: me.isOwner });
  }

  if (action === 'set_topics') {
    if (!me.isOwner) return j({ ok: false, error: 'Only the president can choose who handles each topic.' }, 403);
    const input = (body.topics ?? {}) as Record<string, unknown>;
    const clean: Record<string, string | null> = {};
    for (const t of HELP_TOPICS) {
      const id = input[t] ? String(input[t]) : null;
      if (id && !board.some(b => b.id === id)) return j({ ok: false, error: 'Pick someone on the board.' }, 400);
      clean[t] = id;
    }
    const { data: s } = await sb.from('settings').select('value').eq('tenant_id', TID).maybeSingle();
    const value = { ...((s?.value as Record<string, unknown>) ?? {}), help_topics: clean };
    const { error } = s
      ? await sb.from('settings').update({ value }).eq('tenant_id', TID)
      : await sb.from('settings').insert({ tenant_id: TID, value });
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  if (action === 'list') {
    const view = String(body.view ?? 'open');
    let q = sb.from('help_requests').select(REQ_FIELDS).eq('tenant_id', TID);
    if (!me.isOwner) q = q.eq('assigned_admin_id', me.id);
    if (view === 'open') q = q.neq('status', 'solved');
    else if (view === 'solved') q = q.eq('status', 'solved');
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(100);
    if (error) return j({ ok: false, error: error.message }, 500);
    const rows = data ?? [];
    const ids = rows.map(r => r.id);
    const memberIds = [...new Set(rows.map(r => r.member_id).filter(Boolean))] as string[];
    const hhIds = [...new Set(rows.map(r => r.household_id).filter(Boolean))] as string[];
    const [msgs, mem, hh] = await Promise.all([
      ids.length ? sb.from('help_messages').select('request_id, author_kind, body, photo_path, created_at').in('request_id', ids).neq('author_kind', 'note').order('created_at') : Promise.resolve({ data: [] }),
      memberIds.length ? sb.from('household_members').select('id, name').in('id', memberIds) : Promise.resolve({ data: [] }),
      hhIds.length ? sb.from('households').select('id, family_name').in('id', hhIds) : Promise.resolve({ data: [] }),
    ]);
    const last = new Map<string, { author_kind: string; body: string }>();
    const first = new Map<string, string>();
    const photos = new Set<string>();
    for (const m of (msgs.data ?? []) as { request_id: string; author_kind: string; body: string; photo_path: string | null }[]) {
      if (!first.has(m.request_id)) first.set(m.request_id, m.body);
      last.set(m.request_id, m);
      if (m.photo_path) photos.add(m.request_id);
    }
    const mName = new Map(((mem.data ?? []) as { id: string; name: string }[]).map(m => [m.id, m.name]));
    const hName = new Map(((hh.data ?? []) as { id: string; family_name: string }[]).map(h => [h.id, h.family_name]));
    return j({
      ok: true,
      is_owner: me.isOwner,
      requests: rows.map(r => ({
        ...shapeBoard(r),
        member_name: mName.get(r.member_id ?? '') ?? 'A member',
        family_name: hName.get(r.household_id ?? '') ?? null,
        first_snippet: snippet(first.get(r.id) ?? '', 100),
        waiting_on_board: last.get(r.id)?.author_kind === 'member',
        has_photo: photos.has(r.id),
      })),
    });
  }

  if (action === 'get') {
    const r = await visible(String(body.id ?? ''));
    if (!r) return j({ ok: false, error: 'Request not found' }, 404);
    return j({ ok: true, request: shapeBoard(r), messages: await loadMessages(sb, r.id), member: await memberOf(r), board, is_owner: me.isOwner });
  }

  if (action === 'reply') {
    const r = await visible(String(body.id ?? ''));
    if (!r) return j({ ok: false, error: 'Request not found' }, 404);
    const text = cleanBody(body.body);
    if (!text) return j({ ok: false, error: 'Write a reply first.' }, 400);
    const member = await memberOf(r);
    const { data: msg } = await sb.from('help_messages').insert({
      tenant_id: TID, request_id: r.id, author_kind: 'board', author_admin_id: me.id, body: text,
    }).select('id').single();

    // Text the member (email if there's no cell, or the text didn't go).
    const link = helpLink(tenant.slug, r.id);
    let sent_by: 'text' | 'email' | null = null;
    let send_error: string | null = null;
    if (member.phone) {
      const s = await sendSms({
        sb, tenantId: TID, tenantPlan: tenant.plan, to: member.phone,
        body: replyText(tenant.display_name || 'Your pool', me.name, text, link),
        kind: 'transactional', source: 'help_requests.reply',
      });
      if (s.sent) sent_by = 'text'; else send_error = s.error ?? 'The text did not go through';
    }
    if (!sent_by && member.email) {
      const clubUrl = `https://${tenant.slug}.poolsideapp.com`;
      const e = await sendEmail({
        to: member.email,
        subject: `${tenant.display_name}: ${me.name} replied to your question`,
        html: emailShell({
          tenantName: tenant.display_name, clubUrl,
          preheader: snippet(text, 90),
          contentHtml: `<p style="margin:0 0 12px">${escHtml(me.name)} replied to your ${escHtml(TOPIC_LABELS[r.topic as Topic].toLowerCase())} question:</p>
            <blockquote style="margin:0 0 16px;padding:12px 16px;background:#f1f5f9;border-radius:10px;white-space:pre-wrap">${escHtml(text)}</blockquote>
            <p style="margin:0"><a href="${link}" style="display:inline-block;padding:10px 18px;background:#0a3b5c;color:#fff;border-radius:10px;text-decoration:none;font-weight:600">Read or reply</a></p>`,
        }),
      });
      if (e.sent) { sent_by = 'email'; send_error = null; }
      else send_error = send_error ?? e.error ?? 'The email did not go through';
    }
    if (!member.phone && !member.email) send_error = 'No cell or email on file for this member';
    if (msg) await sb.from('help_messages').update({ sent_by, send_error }).eq('id', msg.id);

    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (r.status === 'open') patch.status = 'in_progress';
    const { data: updated } = await sb.from('help_requests').update(patch).eq('id', r.id).select(REQ_FIELDS).single();
    return j({ ok: true, request: shapeBoard(updated ?? r), message: { id: msg?.id, sent_by, send_error } });
  }

  if (action === 'set_status') {
    const r = await visible(String(body.id ?? ''));
    if (!r) return j({ ok: false, error: 'Request not found' }, 404);
    const status = String(body.status ?? '');
    if (!['open', 'in_progress', 'solved'].includes(status)) return j({ ok: false, error: 'Unknown status' }, 400);
    if (status === r.status) return j({ ok: true, request: shapeBoard(r) });
    const now = new Date().toISOString();
    const patch: Record<string, unknown> = { status, updated_at: now };
    if (status === 'solved') Object.assign(patch, { solved_at: now, solved_by: me.id });
    else Object.assign(patch, { solved_at: null, solved_by: null });
    const { data: updated } = await sb.from('help_requests').update(patch).eq('id', r.id).select(REQ_FIELDS).single();
    if (status === 'solved') {
      await closeHelpTasks(sb, TID, r.id, 'complete', me.id);
      await note(r.id, `Marked solved by ${me.name}`);
    } else if (r.status === 'solved') {
      await note(r.id, `Reopened by ${me.name}`);
      const member = await memberOf(r);
      await openHelpTask(sb, updated ?? r, member.name, 'Reopened by the board', false);
    }
    return j({ ok: true, request: shapeBoard(updated ?? r) });
  }

  if (action === 'assign') {
    const r = await visible(String(body.id ?? ''));
    if (!r) return j({ ok: false, error: 'Request not found' }, 404);
    const to = body.admin_id ? String(body.admin_id) : null;
    if (to && !board.some(b => b.id === to)) return j({ ok: false, error: 'Pick someone on the board.' }, 400);
    if (to === r.assigned_admin_id) return j({ ok: true, request: shapeBoard(r) });
    const { data: updated } = await sb.from('help_requests')
      .update({ assigned_admin_id: to, updated_at: new Date().toISOString() })
      .eq('id', r.id).select(REQ_FIELDS).single();
    await note(r.id, `Handed to ${nameOf(to) ?? 'the president'} by ${me.name}`);
    await closeHelpTasks(sb, TID, r.id, 'dismiss', me.id);
    if ((updated ?? r).status !== 'solved') {
      const member = await memberOf(r);
      const { data: firstMsg } = await sb.from('help_messages').select('body').eq('request_id', r.id)
        .eq('author_kind', 'member').order('created_at').limit(1).maybeSingle();
      await openHelpTask(sb, updated ?? r, member.name, firstMsg?.body ?? '', false);
    }
    return j({ ok: true, request: shapeBoard(updated ?? r) });
  }

  if (action === 'delete') {
    if (!me.isOwner) return j({ ok: false, error: 'Only the president can delete a request.' }, 403);
    const r = await visible(String(body.id ?? ''));
    if (!r) return j({ ok: false, error: 'Request not found' }, 404);
    const { data: withPhotos } = await sb.from('help_messages').select('photo_path')
      .eq('request_id', r.id).not('photo_path', 'is', null);
    const paths = (withPhotos ?? []).map(m => m.photo_path as string);
    if (paths.length) await sb.storage.from(BUCKET).remove(paths);
    await closeHelpTasks(sb, TID, r.id, 'dismiss', me.id);
    const member = await memberOf(r);
    await sb.from('audit_log').insert({
      tenant_id: TID, kind: 'help_request.deleted', entity_type: 'help_request', entity_id: r.id,
      summary: `Deleted a ${TOPIC_LABELS[r.topic as Topic].toLowerCase()} request from ${member.name}`,
      actor_id: me.id, actor_kind: 'tenant_admin',
    });
    const { error } = await sb.from('help_requests').delete().eq('id', r.id).eq('tenant_id', TID);
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});

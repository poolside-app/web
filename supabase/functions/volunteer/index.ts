// =============================================================================
// volunteer — sign-ups: shifts and jobs, with a thank-you (PLAN.md BM)
// =============================================================================
// Doug, 10/23: "some type of sign up genius feature... we need a person for
// the snack shack… or we have a broken sprinkler, here is a photo come fix
// it". Any board member posts a *shift* (a time and spots) or a *job*
// (photos, a do-by date) with a thank-you: nothing, a line, or money off next
// season. A family signs someone up; the poster gets a to-do. On a job the
// volunteer taps Done with a photo; the poster (or the President) approves.
// After a shift the poster ticks who came. Approval gives the thank-you (a
// one-family discount code, shown in the app and emailed) and puts a
// thank-you on the news. Families get a number on their Sign-ups tab, never
// a pop-up or a text. The rules are in _shared/signups.ts.
//
// Public (no auth):
//   { action: 'list_public', slug }       → { ok, opportunities }
// Members (member JWT):
//   { action: 'list' }                     → { ok, enabled, member, open_count, opportunities, mine }
//   { action: 'my_signups' }               → { ok, signups }   (older pages)
//   { action: 'signup', opportunity_id, volunteer_name, member_id? }
//   { action: 'cancel_signup', signup_id }
//   { action: 'done', signup_id, photo_url?, note? }            jobs only
//   { action: 'upload_photo', content_type, base64 }             → { ok, url }
// Board (any board member; not gate iPads):
//   { action: 'list', past? }              → { ok, opportunities }
//   { action: 'create', kind, title, ... } / { action: 'update', id, ... } / { action: 'delete', id }
//   { action: 'roster', opportunity_id }   → { ok, opportunity, signups }
//   { action: 'admin_signup', ... } / { action: 'cancel_admin', signup_id }
//   { action: 'approve', signup_ids }      the poster or the President
//   { action: 'send_back', signup_id, note }
//   { action: 'attendance', opportunity_id, came: [signup ids] }   shifts
//   { action: 'upload_photo', content_type, base64 }
// Cron (x-cron-secret): { action: 'cron_attendance', tenant_id? }
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { boardCaller } from '../_shared/board.ts';
import { householdStatus } from '../_shared/membership_status.ts';
import { enqueueAdminTask } from '../_shared/enqueue_task.ts';
import { renderAndSend } from '../_shared/email_template.ts';
import { keepNewestPosts } from '../_shared/keep_newest.ts';
import {
  KINDS, cleanReward, rewardText, spotsTaken, isOpen, signUpProblem, openCount, cancelProblem, canApprove,
  thanksPost, newThanksCode, type Opp, type Signup,
} from '../_shared/signups.ts';
import { askAttendance, signupLink } from '../_shared/signups_db.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');
const CRON_SECRET  = Deno.env.get('CRON_SECRET');
const BUCKET = 'club-assets';
const PHOTO_TYPES: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_PHOTOS = 4;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type Payload = { sub: string; kind: string; tid: string; hid?: string; synthetic?: boolean };
async function verifyToken(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (!p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

const OPP_FIELDS = 'id, tenant_id, kind, title, description, starts_at, ends_at, due_on, slots_needed, location, event_id, photos, '
  + 'reward_kind, reward_note, reward_amount_cents, reward_percent, created_by, created_by_name, active, closed_at, attendance_asked_at, created_at, updated_at';
const SIGNUP_FIELDS = 'id, tenant_id, opportunity_id, household_id, member_id, volunteer_name, status, notes, done_at, done_photo_url, done_note, '
  + 'approved_at, approved_by_name, sent_back_note, sent_back_at, discount_code_id, thanks_post_id, created_at, updated_at';

function strOrNull(v: unknown, max = 2000): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
}
function isoOrNull(v: unknown): string | null {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
const dateOrNull = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : null;

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* keep empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);
  const nowIso = () => new Date().toISOString();

  // The daily run's part, for one club or all (payment_plans calls the same).
  if (action === 'cron_attendance') {
    if (!CRON_SECRET || (req.headers.get('x-cron-secret') || '') !== CRON_SECRET) return jsonResponse({ ok: false, error: 'Bad cron secret' }, 401);
    return jsonResponse({ ok: true, ...(await askAttendance(sb, strOrNull(body.tenant_id))) });
  }

  if (action === 'list_public') {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!slug) return jsonResponse({ ok: false, error: 'slug required' }, 400);
    const { data: tenant } = await sb.from('tenants').select('id').eq('slug', slug).maybeSingle();
    if (!tenant) return jsonResponse({ ok: false, error: 'Club not found' }, 404);
    const { featureEnabled } = await import('../_shared/tenant_features.ts');
    if (!(await featureEnabled(sb, tenant.id as string, 'volunteer'))) return jsonResponse({ ok: true, opportunities: [] });
    const { opps, signups } = await load(sb, tenant.id as string);
    const now = nowIso();
    return jsonResponse({ ok: true, opportunities: opps.filter(o => isOpen(o as Opp, now)).map(o => forFamily(o, signups, null)) });
  }

  const authHdr = req.headers.get('Authorization') || req.headers.get('authorization') || '';
  const payload = authHdr.startsWith('Bearer ') ? await verifyToken(authHdr.slice(7)) : null;
  if (!payload) return jsonResponse({ ok: false, error: 'Not authenticated' }, 401);
  const TID = payload.tid;

  if (action === 'upload_photo') {
    if (payload.kind !== 'member' && payload.kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
    const saved = await savePhoto(sb, TID, String(body.content_type ?? ''), String(body.base64 ?? ''));
    return saved.url ? jsonResponse({ ok: true, url: saved.url }) : jsonResponse({ ok: false, error: saved.error }, 400);
  }

  // ── Members ───────────────────────────────────────────────────────────
  if (payload.kind === 'member') {
    const HID = payload.hid;
    if (!HID) return jsonResponse({ ok: false, error: 'Member token missing household' }, 401);

    if (action === 'list' || action === 'my_signups') {
      const { featureEnabled } = await import('../_shared/tenant_features.ts');
      const enabled = await featureEnabled(sb, TID, 'volunteer');
      const { opps, signups } = await load(sb, TID);
      const mine = await mineFor(sb, TID, HID, opps, signups);
      if (action === 'my_signups') return jsonResponse({ ok: true, signups: mine });
      if (!enabled) return jsonResponse({ ok: true, enabled: false, member: false, open_count: 0, opportunities: [], mine });
      const st = await householdStatus(sb, TID, HID);
      const now = nowIso();
      const open = opps.filter(o => isOpen(o as Opp, now));
      return jsonResponse({
        ok: true, enabled: true, member: st.member,
        open_count: st.member ? openCount(open as Opp[], signups as Signup[], HID, now) : 0,
        opportunities: open.map(o => forFamily(o, signups, HID)),
        mine,
      });
    }

    if (action === 'signup') {
      const opportunity_id = String(body.opportunity_id ?? '');
      const volunteer_name = strOrNull(body.volunteer_name, 120);
      const member_id = strOrNull(body.member_id);
      if (!opportunity_id) return jsonResponse({ ok: false, error: 'opportunity_id required' }, 400);
      if (!volunteer_name) return jsonResponse({ ok: false, error: 'Who\'s doing it?' }, 400);
      const st = await householdStatus(sb, TID, HID);
      if (!st.member) return jsonResponse({ ok: false, error: `Sign-ups are for ${st.season} members. Renew to sign up.` }, 403);
      const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('id', opportunity_id).eq('tenant_id', TID).maybeSingle();
      if (!opp) return jsonResponse({ ok: false, error: 'That sign-up isn\'t there any more.' }, 404);
      if (member_id) {
        const { data: m } = await sb.from('household_members').select('id, household_id, active').eq('id', member_id).maybeSingle();
        if (!m || m.household_id !== HID || !m.active) return jsonResponse({ ok: false, error: 'Member not in your household' }, 403);
      }
      const { data: theirs } = await sb.from('volunteer_signups').select(SIGNUP_FIELDS).eq('opportunity_id', opp.id);
      const why = signUpProblem(opp as Opp, (theirs ?? []) as Signup[], { householdId: HID, memberId: member_id, nowIso: nowIso() });
      if (why) return jsonResponse({ ok: false, error: why }, 409);
      const { data, error } = await sb.from('volunteer_signups').insert({
        tenant_id: TID, opportunity_id, household_id: HID, member_id, volunteer_name, notes: strOrNull(body.notes, 300),
      }).select(SIGNUP_FIELDS).single();
      if (error) {
        if (/unique|duplicate/i.test(error.message)) return jsonResponse({ ok: false, error: 'They\'re already signed up for this.' }, 409);
        return jsonResponse({ ok: false, error: error.message }, 500);
      }
      const fam = await familyName(sb, HID);
      await enqueueAdminTask(sb, {
        tenant_id: TID, target_scopes: [], assigned_admin_id: opp.created_by ?? null, kind: 'signup.taken',
        summary: `${volunteer_name} (${fam}) signed up: "${opp.title}"`, link_url: signupLink(opp.id),
        source_kind: 'signup', source_id: opp.id, metadata: { signup_id: data.id }, skip_push: true,
      });
      return jsonResponse({ ok: true, signup: data });
    }

    if (action === 'cancel_signup') {
      const s = await ownSignup(sb, TID, HID, String(body.signup_id ?? ''));
      if (!s) return jsonResponse({ ok: false, error: 'Not found' }, 404);
      if (s.status === 'cancelled') return jsonResponse({ ok: true });
      const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('id', s.opportunity_id).maybeSingle();
      const why = opp ? cancelProblem(s as Signup, opp as Opp, nowIso()) : null;
      if (why) return jsonResponse({ ok: false, error: why }, 409);
      const { error } = await sb.from('volunteer_signups').update({ status: 'cancelled', updated_at: nowIso() }).eq('id', s.id).eq('tenant_id', TID);
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      await closeTasks(sb, TID, s.opportunity_id, ['signup.taken'], s.id);
      return jsonResponse({ ok: true });
    }

    if (action === 'done') {
      const s = await ownSignup(sb, TID, HID, String(body.signup_id ?? ''));
      if (!s) return jsonResponse({ ok: false, error: 'Not found' }, 404);
      const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('id', s.opportunity_id).maybeSingle();
      if (!opp) return jsonResponse({ ok: false, error: 'That sign-up isn\'t there any more.' }, 404);
      if (opp.kind !== 'job') return jsonResponse({ ok: false, error: 'After a shift, the board ticks who came.' }, 409);
      if (s.status !== 'confirmed') return jsonResponse({ ok: false, error: s.status === 'done' ? 'Already marked done; the board will check it.' : 'This one is closed.' }, 409);
      const photo = strOrNull(body.photo_url, 500);
      if (photo && !photo.startsWith(photoPrefix(TID))) return jsonResponse({ ok: false, error: 'Add the photo again.' }, 400);
      const { data, error } = await sb.from('volunteer_signups').update({
        status: 'done', done_at: nowIso(), done_photo_url: photo, done_note: strOrNull(body.note, 300),
        sent_back_note: null, sent_back_at: null, updated_at: nowIso(),
      }).eq('id', s.id).eq('tenant_id', TID).select(SIGNUP_FIELDS).single();
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      await closeTasks(sb, TID, opp.id, ['signup.taken'], s.id);
      await enqueueAdminTask(sb, {
        tenant_id: TID, target_scopes: [], assigned_admin_id: opp.created_by ?? null, kind: 'signup.done',
        summary: `Approve: ${await familyName(sb, HID)} finished "${opp.title}"`, link_url: signupLink(opp.id),
        source_kind: 'signup', source_id: opp.id, metadata: { signup_id: s.id }, skip_push: true,
      });
      return jsonResponse({ ok: true, signup: data });
    }

    return jsonResponse({ ok: false, error: `Unknown member action: ${action}` }, 400);
  }

  // ── Board: any board member (not gate iPads) ─────────────────────────
  if (payload.kind !== 'tenant_admin') return jsonResponse({ ok: false, error: 'Forbidden' }, 403);
  const caller = payload.synthetic ? { id: null as string | null, isOwner: true, name: 'Poolside' } : await boardCaller(sb, payload.sub, TID);
  if (!caller) return jsonResponse({ ok: false, error: 'Sign-ups are for board members.' }, 403);

  if (action === 'list') {
    let q = sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('tenant_id', TID).eq('active', true);
    if (!body.past) q = q.or(`closed_at.is.null,closed_at.gte.${new Date(Date.now() - 14 * 86400_000).toISOString()}`);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const ids = (data ?? []).map(o => o.id);
    const { data: signups } = ids.length ? await sb.from('volunteer_signups').select('opportunity_id, household_id, member_id, status').in('opportunity_id', ids) : { data: [] };
    return jsonResponse({ ok: true, opportunities: (data ?? []).map(o => forBoard(o, signups ?? [], caller)) });
  }

  if (action === 'create' || action === 'update') {
    const existing = action === 'update'
      ? (await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('id', String(body.id ?? '')).eq('tenant_id', TID).maybeSingle()).data
      : null;
    if (action === 'update' && !existing) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    const has = (k: string) => action === 'create' || body[k] !== undefined;
    const patch: Row = { updated_at: nowIso() };
    const kind = has('kind') ? String(body.kind ?? 'shift') : existing!.kind;
    if (!(KINDS as string[]).includes(kind)) return jsonResponse({ ok: false, error: 'A shift or a job.' }, 400);
    patch.kind = kind;
    if (has('title')) {
      const t = strOrNull(body.title, 140);
      if (!t) return jsonResponse({ ok: false, error: 'Give it a title.' }, 400);
      patch.title = t;
    }
    if (has('description')) patch.description = strOrNull(body.description, 2000);
    if (has('location')) patch.location = strOrNull(body.location, 120);
    if (has('event_id')) patch.event_id = strOrNull(body.event_id);
    if (has('slots_needed')) {
      const n = Math.trunc(Number(body.slots_needed ?? (kind === 'job' ? 1 : 2)));
      if (!(n >= 1 && n <= 100)) return jsonResponse({ ok: false, error: 'Between 1 and 100 people.' }, 400);
      patch.slots_needed = n;
    }
    if (has('starts_at')) patch.starts_at = isoOrNull(body.starts_at);
    if (has('ends_at')) patch.ends_at = isoOrNull(body.ends_at);
    if (has('due_on')) patch.due_on = dateOrNull(body.due_on);
    const starts = patch.starts_at !== undefined ? patch.starts_at : existing?.starts_at;
    const ends = patch.ends_at !== undefined ? patch.ends_at : existing?.ends_at;
    if (kind === 'shift' && !starts) return jsonResponse({ ok: false, error: 'When does the shift start?' }, 400);
    if (starts && ends && ends < starts) return jsonResponse({ ok: false, error: 'It has to end after it starts.' }, 400);
    if (has('photos')) {
      const list = (Array.isArray(body.photos) ? body.photos : []).map(String).filter(Boolean);
      if (list.length > MAX_PHOTOS) return jsonResponse({ ok: false, error: `${MAX_PHOTOS} photos at most.` }, 400);
      if (list.some(u => !u.startsWith(photoPrefix(TID)))) return jsonResponse({ ok: false, error: 'Add the photos again.' }, 400);
      patch.photos = list;
    }
    if (has('reward_kind')) {
      const r = cleanReward(body);
      if (!r.ok) return jsonResponse({ ok: false, error: r.error }, 400);
      Object.assign(patch, r.reward);
    }
    if (action === 'create') {
      Object.assign(patch, { tenant_id: TID, created_by: caller.id, created_by_name: caller.name });
      const { data, error } = await sb.from('volunteer_opportunities').insert(patch).select(OPP_FIELDS).single();
      if (error) return jsonResponse({ ok: false, error: error.message }, 500);
      return jsonResponse({ ok: true, opportunity: forBoard(data, [], caller) });
    }
    const { data, error } = await sb.from('volunteer_opportunities').update(patch).eq('id', existing!.id).eq('tenant_id', TID).select(OPP_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    const { data: signups } = await sb.from('volunteer_signups').select('opportunity_id, household_id, member_id, status').eq('opportunity_id', data.id);
    return jsonResponse({ ok: true, opportunity: forBoard(data, signups ?? [], caller) });
  }

  if (action === 'delete') {
    const id = String(body.id ?? '');
    const { error } = await sb.from('volunteer_opportunities').update({ active: false, updated_at: nowIso() }).eq('id', id).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await closeTasks(sb, TID, id, ['signup.taken', 'signup.done', 'signup.attendance']);
    return jsonResponse({ ok: true });
  }

  if (action === 'roster') {
    const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('id', String(body.opportunity_id ?? '')).eq('tenant_id', TID).maybeSingle();
    if (!opp) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    const { data: signups } = await sb.from('volunteer_signups').select(SIGNUP_FIELDS).eq('tenant_id', TID).eq('opportunity_id', opp.id).order('created_at', { ascending: true });
    const hids = [...new Set((signups ?? []).map(s => s.household_id))];
    const codeIds = (signups ?? []).map(s => s.discount_code_id).filter(Boolean);
    const [{ data: hhs }, { data: codes }] = await Promise.all([
      hids.length ? sb.from('households').select('id, family_name').in('id', hids) : Promise.resolve({ data: [] as Row[] }),
      codeIds.length ? sb.from('discount_codes').select('id, code').in('id', codeIds) : Promise.resolve({ data: [] as Row[] }),
    ]);
    const fam = new Map((hhs ?? []).map(h => [h.id, h.family_name])), code = new Map((codes ?? []).map(c => [c.id, c.code]));
    return jsonResponse({
      ok: true, opportunity: forBoard(opp, signups ?? [], caller),
      signups: (signups ?? []).map(s => ({ ...s, family_name: fam.get(s.household_id) ?? null, code: s.discount_code_id ? code.get(s.discount_code_id) ?? null : null })),
    });
  }

  if (action === 'admin_signup') {
    const opportunity_id = String(body.opportunity_id ?? '');
    const household_id = String(body.household_id ?? '');
    const volunteer_name = strOrNull(body.volunteer_name, 120);
    if (!opportunity_id || !household_id || !volunteer_name) return jsonResponse({ ok: false, error: 'opportunity_id, household_id, volunteer_name required' }, 400);
    const { data, error } = await sb.from('volunteer_signups').insert({
      tenant_id: TID, opportunity_id, household_id, volunteer_name, member_id: strOrNull(body.member_id), notes: strOrNull(body.notes, 300),
    }).select(SIGNUP_FIELDS).single();
    if (error) return jsonResponse({ ok: false, error: /unique|duplicate/i.test(error.message) ? 'Already signed up' : error.message }, /unique|duplicate/i.test(error.message) ? 409 : 500);
    return jsonResponse({ ok: true, signup: data });
  }

  if (action === 'cancel_admin') {
    const sid = String(body.signup_id ?? '');
    const { data: s } = await sb.from('volunteer_signups').select('id, opportunity_id').eq('id', sid).eq('tenant_id', TID).maybeSingle();
    if (!s) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    const { error } = await sb.from('volunteer_signups').update({ status: 'cancelled', updated_at: nowIso() }).eq('id', sid).eq('tenant_id', TID);
    if (error) return jsonResponse({ ok: false, error: error.message }, 500);
    await closeTasks(sb, TID, s.opportunity_id, ['signup.taken', 'signup.done'], sid);
    return jsonResponse({ ok: true });
  }

  if (action === 'approve' || action === 'send_back' || action === 'attendance') {
    const oppId = action === 'attendance' ? String(body.opportunity_id ?? '') : null;
    const ids = action === 'approve' ? (Array.isArray(body.signup_ids) ? body.signup_ids.map(String) : [])
      : action === 'send_back' ? [String(body.signup_id ?? '')] : [];
    const { data: rows } = oppId
      ? await sb.from('volunteer_signups').select(SIGNUP_FIELDS).eq('tenant_id', TID).eq('opportunity_id', oppId)
      : await sb.from('volunteer_signups').select(SIGNUP_FIELDS).eq('tenant_id', TID).in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
    const list = rows ?? [];
    const theOpp = oppId ?? list[0]?.opportunity_id;
    if (!theOpp || list.some(s => s.opportunity_id !== theOpp)) return jsonResponse({ ok: false, error: 'Pick sign-ups from one post.' }, 400);
    const { data: opp } = await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('id', theOpp).eq('tenant_id', TID).maybeSingle();
    if (!opp) return jsonResponse({ ok: false, error: 'Not found' }, 404);
    if (!canApprove(opp as Opp, caller)) return jsonResponse({ ok: false, error: 'Only the board member who posted it, or the President, can approve it.' }, 403);
    const now = nowIso();
    const by = { approved_at: now, approved_by: caller.id, approved_by_name: caller.name, updated_at: now };

    if (action === 'send_back') {
      const note = strOrNull(body.note, 300);
      const s = list[0];
      if (!note) return jsonResponse({ ok: false, error: 'Say what still needs doing.' }, 400);
      if (s.status !== 'done') return jsonResponse({ ok: false, error: 'Only a job marked done can go back.' }, 409);
      await sb.from('volunteer_signups').update({ status: 'confirmed', sent_back_note: note, sent_back_at: now, updated_at: now }).eq('id', s.id);
      await closeTasks(sb, TID, opp.id, ['signup.done'], s.id);
      return jsonResponse({ ok: true });
    }

    let approved: Row[];
    if (action === 'attendance') {
      if (opp.kind !== 'shift') return jsonResponse({ ok: false, error: 'Ticking who came is for shifts.' }, 400);
      const came = new Set((Array.isArray(body.came) ? body.came : []).map(String));
      const live = list.filter(s => s.status === 'confirmed');
      approved = live.filter(s => came.has(s.id));
      const missed = live.filter(s => !came.has(s.id)).map(s => s.id);
      if (approved.length) await sb.from('volunteer_signups').update({ status: 'approved', ...by }).in('id', approved.map(s => s.id));
      if (missed.length) await sb.from('volunteer_signups').update({ status: 'no_show', updated_at: now }).in('id', missed);
      await sb.from('volunteer_opportunities').update({ closed_at: now, attendance_asked_at: opp.attendance_asked_at ?? now, updated_at: now }).eq('id', opp.id);
      await closeTasks(sb, TID, opp.id, ['signup.taken', 'signup.attendance']);
    } else {
      approved = list.filter(s => s.status === 'done' || s.status === 'confirmed');
      if (!approved.length) return jsonResponse({ ok: false, error: 'Nothing here to approve.' }, 409);
      await sb.from('volunteer_signups').update({ status: 'approved', ...by }).in('id', approved.map(s => s.id));
      for (const s of approved) await closeTasks(sb, TID, opp.id, ['signup.taken', 'signup.done'], s.id);
      const { data: all } = await sb.from('volunteer_signups').select('status').eq('opportunity_id', opp.id);
      if (opp.kind === 'job' && (all ?? []).filter(s => s.status === 'approved').length >= Number(opp.slots_needed ?? 1)) {
        await sb.from('volunteer_opportunities').update({ closed_at: now, updated_at: now }).eq('id', opp.id);
      }
    }
    if (approved.length) await giveThanks(sb, TID, opp, approved, caller);
    return jsonResponse({ ok: true, approved: approved.length });
  }

  return jsonResponse({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// ── Helpers ──────────────────────────────────────────────────────────────

const photoPrefix = (tid: string) => `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${tid}/signups/`;

async function savePhoto(sb: SupabaseClient, tid: string, ct: string, b64: string): Promise<{ url?: string; error?: string }> {
  const ext = PHOTO_TYPES[ct.trim()];
  if (!ext) return { error: 'Photos must be JPG, PNG, WebP or GIF.' };
  let bytes: Uint8Array;
  try {
    const bin = atob(b64);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } catch { return { error: 'That photo could not be read.' }; }
  if (!bytes.byteLength) return { error: 'That photo is empty.' };
  if (bytes.byteLength > 8 * 1024 * 1024) return { error: 'That photo is too big (8 MB at most).' };
  const path = `${tid}/signups/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, bytes, { contentType: ct, upsert: false });
  if (error) return { error: 'The photo could not be saved. Try again.' };
  return { url: sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl };
}

async function load(sb: SupabaseClient, tid: string) {
  const { data: opps } = await sb.from('volunteer_opportunities').select(OPP_FIELDS).eq('tenant_id', tid).eq('active', true)
    .is('closed_at', null).order('created_at', { ascending: false }).limit(200);
  const ids = (opps ?? []).map(o => o.id);
  const { data: signups } = ids.length
    ? await sb.from('volunteer_signups').select('id, opportunity_id, household_id, member_id, status').in('opportunity_id', ids)
    : { data: [] as Row[] };
  return { opps: opps ?? [], signups: signups ?? [] };
}

/** What a family sees: no board-only fields. Shifts by date, jobs by do-by date. */
function forFamily(o: Row, signups: Row[], hid: string | null) {
  const taken = spotsTaken(o.id, signups as Signup[]);
  return {
    id: o.id, kind: o.kind, title: o.title, description: o.description, starts_at: o.starts_at, ends_at: o.ends_at, due_on: o.due_on,
    location: o.location, photos: o.photos ?? [], reward_text: rewardText(o as Opp), posted_by: o.created_by_name ?? null,
    spots: o.slots_needed, spots_left: Math.max(0, Number(o.slots_needed ?? 1) - taken), slots_filled: taken, slots_needed: o.slots_needed,
    mine: hid ? signups.filter(s => s.opportunity_id === o.id && s.household_id === hid && s.status !== 'cancelled').map(s => ({ id: s.id, status: s.status, member_id: s.member_id })) : [],
  };
}

function forBoard(o: Row, signups: Row[], caller: { id: string | null; isOwner: boolean }) {
  const mine = signups.filter(s => s.opportunity_id === o.id);
  return {
    ...o, reward_text: rewardText(o as Opp), slots_filled: spotsTaken(o.id, mine as Signup[]),
    waiting: mine.filter(s => s.status === 'done').length, approved: mine.filter(s => s.status === 'approved').length,
    can_approve: canApprove(o as Opp, caller),
  };
}

/** A family's own sign-ups, newest first, with their thank-you code once approved. */
async function mineFor(sb: SupabaseClient, tid: string, hid: string, open: Row[], _all: Row[]) {
  const { data: rows } = await sb.from('volunteer_signups').select(SIGNUP_FIELDS).eq('tenant_id', tid).eq('household_id', hid)
    .neq('status', 'cancelled').order('created_at', { ascending: false }).limit(50);
  const list = rows ?? [];
  const oppIds = [...new Set(list.map(s => s.opportunity_id))].filter(id => !open.some(o => o.id === id));
  const codeIds = list.map(s => s.discount_code_id).filter(Boolean);
  const [{ data: more }, { data: codes }] = await Promise.all([
    oppIds.length ? sb.from('volunteer_opportunities').select(OPP_FIELDS).in('id', oppIds) : Promise.resolve({ data: [] as Row[] }),
    codeIds.length ? sb.from('discount_codes').select('id, code').in('id', codeIds) : Promise.resolve({ data: [] as Row[] }),
  ]);
  const opps = new Map([...open, ...(more ?? [])].map(o => [o.id, o]));
  const code = new Map((codes ?? []).map(c => [c.id, c.code]));
  return list.map(s => {
    const o = opps.get(s.opportunity_id) ?? {};
    return {
      id: s.id, opportunity_id: s.opportunity_id, status: s.status, volunteer_name: s.volunteer_name,
      title: o.title ?? null, kind: o.kind ?? null, starts_at: o.starts_at ?? null, ends_at: o.ends_at ?? null, due_on: o.due_on ?? null,
      location: o.location ?? null, reward_text: o.reward_kind ? rewardText(o as Opp) : null,
      done_at: s.done_at, done_photo_url: s.done_photo_url, sent_back_note: s.sent_back_note, approved_at: s.approved_at,
      code: s.discount_code_id ? code.get(s.discount_code_id) ?? null : null,
      can_cancel: o.id ? cancelProblem(s as Signup, o as Opp, new Date().toISOString()) === null : false,
      opportunity: o.id ? { id: o.id, title: o.title, starts_at: o.starts_at, location: o.location } : null,
    };
  });
}

async function ownSignup(sb: SupabaseClient, tid: string, hid: string, id: string) {
  if (!id) return null;
  const { data } = await sb.from('volunteer_signups').select(SIGNUP_FIELDS).eq('id', id).eq('tenant_id', tid).maybeSingle();
  return data && data.household_id === hid ? data : null;
}

async function familyName(sb: SupabaseClient, hid: string): Promise<string> {
  const { data } = await sb.from('households').select('family_name').eq('id', hid).maybeSingle();
  return String(data?.family_name ?? 'A family');
}

/** Close the poster's to-dos for a post, or for one sign-up on it. */
async function closeTasks(sb: SupabaseClient, tid: string, oppId: string, kinds: string[], signupId?: string) {
  let q = sb.from('admin_tasks').update({ completed_at: new Date().toISOString() })
    .eq('tenant_id', tid).eq('source_kind', 'signup').eq('source_id', oppId).in('kind', kinds).is('completed_at', null);
  if (signupId) q = q.eq('metadata->>signup_id', signupId);
  await q;
}

/** The thank-you: a one-family code (shown and emailed) when it's money off,
 *  and one thank-you on the news naming the families, with the Done photo. */
async function giveThanks(sb: SupabaseClient, tid: string, opp: Row, rows: Row[], caller: { id: string | null; name: string }) {
  const hids = [...new Set(rows.map(s => s.household_id))];
  const { data: hhs } = await sb.from('households').select('id, family_name').in('id', hids);
  const fam = new Map((hhs ?? []).map(h => [h.id, String(h.family_name ?? '')]));
  const reward = rewardText(opp as Opp);

  if (opp.reward_kind === 'discount') {
    for (const s of rows) {
      let made: Row | null = null;
      for (let i = 0; i < 5 && !made; i++) {
        const { data, error } = await sb.from('discount_codes').insert({
          tenant_id: tid, code: newThanksCode(), label: `Thank-you: ${opp.title} (${fam.get(s.household_id) || 'a family'})`.slice(0, 140),
          amount_cents: opp.reward_amount_cents ?? null, percent_off: opp.reward_percent ?? null,
          max_uses: 1, show_on_home: false, active: true, created_by: caller.id,
        }).select('id, code').single();
        if (data) made = data;
        else if (!/unique|duplicate/i.test(error?.message ?? '')) { console.error('thanks code:', error?.message); break; }
      }
      if (!made) continue;
      await sb.from('volunteer_signups').update({ discount_code_id: made.id }).eq('id', s.id);
      const { data: people } = await sb.from('household_members').select('name, email, role').eq('household_id', s.household_id)
        .eq('active', true).not('email', 'is', null);
      const to = (people ?? []).sort((a, b) => (a.role === 'primary' ? -1 : 0) - (b.role === 'primary' ? -1 : 0))[0];
      if (to?.email) {
        try {
          await renderAndSend(sb, { tenantId: tid, templateKey: 'signup_thanks', to: to.email, variables: {
            primary_name: String(to.name ?? '').split(' ')[0] || 'there', family_name: fam.get(s.household_id) ?? '',
            signup_title: opp.title, reward_text: reward, code: made.code,
          } });
        } catch (e) { console.error('thanks email:', (e as Error).message); }
      }
    }
  }

  const post = thanksPost(opp as Opp, rows.map(s => fam.get(s.household_id) ?? ''));
  const photo = rows.map(s => s.done_photo_url).find(Boolean) ?? (Array.isArray(opp.photos) ? opp.photos[0] : null) ?? null;
  const now = new Date().toISOString();
  const { data: p, error } = await sb.from('posts').insert({
    tenant_id: tid, title: post.title, body: post.body, image_url: photo, kind: 'thanks',
    pinned: false, active: true, published_at: now, notify_members: false, created_by: caller.id,
  }).select('id').single();
  if (error) { console.error('thanks post:', error.message); return; }
  await sb.from('volunteer_signups').update({ thanks_post_id: p.id }).in('id', rows.map(s => s.id));
  try { await keepNewestPosts(sb, tid, caller.id); } catch (e) { console.error('keep newest:', (e as Error).message); }
}

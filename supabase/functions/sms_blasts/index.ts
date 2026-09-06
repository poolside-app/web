// =============================================================================
// sms_blasts — text every member, with a second pair of eyes
// =============================================================================
// A blast is the most dangerous button in the app. It is irreversible, it
// reaches 150 phones in seconds, it costs real money, and the people pressing
// it are volunteers doing club admin late at night on a phone. So one admin
// composes and a DIFFERENT admin releases it.
//
// Actions (tenant admin, 'communications' scope):
//   { action: 'preview', body }                → cost + reach before committing
//   { action: 'create', body, audience? }      → queues it for approval
//   { action: 'approve', id, solo_confirm? }   → releases it (sends)
//   { action: 'cancel', id, reason? }          → composer or anyone can bin it
//   { action: 'list' }                         → pending + recent history
//
// Clubs with one admin cannot get a second person, so they confirm explicitly
// instead. That is recorded, so "nobody checked this" and "there was nobody to
// check it" stay distinguishable afterwards.
// =============================================================================

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verify } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { measureSms, renderBlast, estimateCostCents, normalizeForSms } from '../_shared/sms_text.ts';
import { checkSmsCap, consumeSmsCredit } from '../_shared/sms_cap.ts';
import { sendSms } from '../_shared/send_sms.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const JWT_SECRET   = Deno.env.get('ADMIN_JWT_SECRET');

// One segment. Not a technical limit — a deliberate one. A text people read on
// a pool deck should be one screen, and a second segment doubles the bill on
// every recipient. Anything longer belongs in an announcement or an email.
const MAX_SEGMENTS = 1;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
function j(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
}

type Payload = { sub: string; kind: string; tid: string; slug: string; scopes?: string[]; role_template?: string; is_super?: boolean; synthetic?: boolean };

async function verifyAdmin(token: string): Promise<Payload | null> {
  if (!JWT_SECRET) return null;
  try {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(JWT_SECRET),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    const p = await verify(token, key) as Record<string, unknown>;
    if (p.kind !== 'tenant_admin' || !p.sub || !p.tid) return null;
    return p as unknown as Payload;
  } catch { return null; }
}

async function canSend(sb: SupabaseClient, p: Payload): Promise<boolean> {
  if (p.is_super || p.role_template === 'owner') return true;
  if (Array.isArray(p.scopes) && p.scopes.includes('communications')) return true;
  if (p.role_template !== undefined && p.scopes !== undefined) return false;
  const { data: a } = await sb.from('admin_users')
    .select('role_template, scopes, is_super, active').eq('id', p.sub).maybeSingle();
  if (!a || !a.active) return false;
  if (a.is_super || a.role_template === 'owner') return true;
  return ((a.scopes as string[] | null) ?? []).includes('communications');
}

/** Everyone who would actually receive this: adults with a phone on file. */
async function recipients(sb: SupabaseClient, tenantId: string) {
  const { data: households } = await sb.from('households')
    .select('id').eq('tenant_id', tenantId).eq('active', true);
  const ids = (households ?? []).map(h => h.id as string);
  if (!ids.length) return [] as Array<{ id: string; phone_e164: string }>;
  const { data: members } = await sb.from('household_members')
    .select('id, phone_e164, role, active')
    .eq('tenant_id', tenantId).eq('active', true)
    .in('household_id', ids)
    .in('role', ['primary', 'adult'])
    .not('phone_e164', 'is', null);
  // One text per number, however many memberships a person appears on.
  const seen = new Set<string>();
  const out: Array<{ id: string; phone_e164: string }> = [];
  for (const m of (members ?? [])) {
    const ph = m.phone_e164 as string;
    if (!ph || seen.has(ph)) continue;
    seen.add(ph);
    out.push({ id: m.id as string, phone_e164: ph });
  }
  return out;
}

async function activeAdminCount(sb: SupabaseClient, tenantId: string): Promise<number> {
  const { count } = await sb.from('admin_users')
    .select('*', { count: 'exact', head: true })
    .eq('tenant_id', tenantId).eq('active', true);
  return count ?? 0;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return j({ ok: false, error: 'POST required' }, 405);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* empty */ }
  const action = String(body.action ?? '');
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const payload = await verifyAdmin(token);
  if (!payload) return j({ ok: false, error: 'Not authenticated' }, 401);
  if (!(await canSend(sb, payload))) return j({ ok: false, error: 'Missing communications scope' }, 403);

  const TID = payload.tid;
  const me = payload.synthetic ? null : payload.sub;

  const { data: tenant } = await sb.from('tenants')
    .select('id, slug, display_name, plan, sms_credits').eq('id', TID).maybeSingle();
  if (!tenant) return j({ ok: false, error: 'Club not found' }, 404);
  const clubName = String(tenant.display_name ?? 'Your club');

  // ── preview: what will this cost, and who gets it? ──────────────────────
  if (action === 'preview' || action === 'create') {
    const raw = String(body.body ?? '').trim();
    if (!raw) return j({ ok: false, error: 'Write a message first.' }, 400);

    const rendered = renderBlast(clubName, raw);
    const m = measureSms(rendered);
    const people = await recipients(sb, TID);
    const cap = await checkSmsCap(sb, TID, 'campaign', tenant.plan as string);

    const tooLong = m.segments > MAX_SEGMENTS;
    const info = {
      rendered,
      chars: m.chars,
      segments: m.segments,
      encoding: m.encoding,
      remaining: m.remaining,
      too_long: tooLong,
      recipient_count: people.length,
      est_cost_cents: estimateCostCents(people.length, m.segments),
      cap: { used: cap.used, cap: cap.cap, remaining: cap.remaining, credits: cap.credits, blocked: cap.blocked },
      admin_count: await activeAdminCount(sb, TID),
    };

    if (action === 'preview') return j({ ok: true, ...info });

    if (tooLong) {
      return j({ ok: false, error: `Too long by ${Math.abs(m.remaining)} characters — keep it to one text.`, ...info }, 400);
    }
    if (!people.length) {
      return j({ ok: false, error: 'Nobody on your roster has a phone number on file yet.', ...info }, 400);
    }
    // Blocked here rather than at approval time, so an admin is not left with
    // an approved blast that silently cannot send.
    if (cap.blocked) {
      return j({ ok: false, error: `Your monthly texts are used up (${cap.used}/${cap.cap}) and you have no top-up credits left.`, ...info }, 429);
    }

    const { data: created, error } = await sb.from('sms_blasts').insert({
      tenant_id: TID,
      body: normalizeForSms(raw),
      audience: 'all',
      created_by: me,
      recipient_count: people.length,
      segment_count: m.segments,
      est_cost_cents: info.est_cost_cents,
    }).select('id, expires_at').single();
    if (error || !created) return j({ ok: false, error: error?.message || 'Could not queue the message' }, 500);

    await sb.from('audit_log').insert({
      tenant_id: TID, kind: 'sms_blast.queued',
      entity_type: 'sms_blast', entity_id: created.id,
      summary: `Queued a text to ${people.length} member${people.length === 1 ? '' : 's'} — awaiting a second admin`,
      actor_id: me, actor_kind: 'tenant_admin',
    });

    return j({ ok: true, id: created.id, expires_at: created.expires_at, ...info });
  }

  // ── approve: the second pair of eyes, and the send ──────────────────────
  if (action === 'approve') {
    const id = String(body.id ?? '');
    if (!id) return j({ ok: false, error: 'id required' }, 400);

    const { data: blast } = await sb.from('sms_blasts')
      .select('*').eq('id', id).eq('tenant_id', TID).maybeSingle();
    if (!blast) return j({ ok: false, error: 'Message not found' }, 404);
    if (blast.status !== 'pending_approval') {
      return j({ ok: false, error: `This message was already ${blast.status}.` }, 409);
    }
    if (new Date(blast.expires_at as string) < new Date()) {
      await sb.from('sms_blasts').update({ status: 'expired' }).eq('id', id);
      return j({ ok: false, error: 'This message expired — messages must be approved within 24 hours. Write a new one.' }, 409);
    }

    // The whole point of the feature.
    const adminCount = await activeAdminCount(sb, TID);
    const samePerson = !!me && blast.created_by === me;
    if (needsSecondAdmin(samePerson, adminCount, body.solo_confirm === true)) {
      return j({
        ok: false,
        error: 'Someone else on your board needs to approve this. Ask another admin to open Announcements and release it.',
        needs_second_admin: true,
      }, 403);
    }

    const people = await recipients(sb, TID);
    if (!people.length) return j({ ok: false, error: 'Nobody has a phone number on file.' }, 400);

    const rendered = renderBlast(clubName, String(blast.body));
    let sent = 0, failed = 0, capped = 0;

    for (const p of people) {
      const cap = await checkSmsCap(sb, TID, 'campaign', tenant.plan as string);
      if (cap.blocked) { capped++; continue; }
      const r = await sendSms({
        sb, tenantId: TID, tenantPlan: tenant.plan as string,
        to: p.phone_e164, body: rendered, kind: 'campaign',
      });
      if (r.sent) {
        sent++;
        // Only spend a purchased credit on a text that actually went out, and
        // only once the monthly allowance is already gone.
        if (cap.using_credits) await consumeSmsCredit(sb, TID);
      } else if (r.capped) capped++;
      else failed++;
    }

    await sb.from('sms_blasts').update({
      status: sent > 0 ? 'sent' : 'failed',
      approved_by: me,
      approved_at: new Date().toISOString(),
      solo_confirmed: body.solo_confirm === true && adminCount <= 1,
      sent_at: new Date().toISOString(),
      sent_count: sent,
      failed_count: failed + capped,
    }).eq('id', id);

    await sb.from('audit_log').insert({
      tenant_id: TID, kind: 'sms_blast.sent',
      entity_type: 'sms_blast', entity_id: id,
      summary: `Texted ${sent} member${sent === 1 ? '' : 's'}${capped ? ` (${capped} held back by SMS limits)` : ''}`,
      actor_id: me, actor_kind: 'tenant_admin',
    });

    return j({ ok: true, sent, failed, capped, total: people.length });
  }

  // ── cancel ──────────────────────────────────────────────────────────────
  if (action === 'cancel') {
    const id = String(body.id ?? '');
    if (!id) return j({ ok: false, error: 'id required' }, 400);
    const { error } = await sb.from('sms_blasts')
      .update({ status: 'cancelled', cancel_reason: String(body.reason ?? '').slice(0, 300) || null })
      .eq('id', id).eq('tenant_id', TID).eq('status', 'pending_approval');
    if (error) return j({ ok: false, error: error.message }, 500);
    return j({ ok: true });
  }

  // ── list: what is waiting, and what went out ────────────────────────────
  if (action === 'list') {
    // Expire stale drafts on read, so the queue never shows something that
    // could not be released anyway.
    await sb.from('sms_blasts').update({ status: 'expired' })
      .eq('tenant_id', TID).eq('status', 'pending_approval')
      .lt('expires_at', new Date().toISOString());

    const { data: rows } = await sb.from('sms_blasts')
      .select('*').eq('tenant_id', TID)
      .order('created_at', { ascending: false }).limit(30);

    const ids = [...new Set((rows ?? []).flatMap(r => [r.created_by, r.approved_by]).filter(Boolean))] as string[];
    const names: Record<string, string> = {};
    if (ids.length) {
      const { data: admins } = await sb.from('admin_users').select('id, display_name, username').in('id', ids);
      for (const a of (admins ?? [])) names[a.id as string] = (a.display_name as string) || (a.username as string) || 'An admin';
    }

    const cap = await checkSmsCap(sb, TID, 'campaign', tenant.plan as string);
    return j({
      ok: true,
      blasts: (rows ?? []).map(r => ({
        ...r,
        created_by_name: r.created_by ? (names[r.created_by as string] ?? 'An admin') : 'An admin',
        approved_by_name: r.approved_by ? (names[r.approved_by as string] ?? 'An admin') : null,
        is_mine: !!me && r.created_by === me,
      })),
      admin_count: await activeAdminCount(sb, TID),
      cap: { used: cap.used, cap: cap.cap, remaining: cap.remaining, credits: cap.credits },
      me,
    });
  }

  return j({ ok: false, error: `Unknown action: ${action}` }, 400);
});

// The approval rule, in one place: block only when the person releasing it is
// the person who wrote it AND the club has somebody else who could do it
// instead. A sole admin has no second pair of eyes available, so they confirm
// deliberately rather than being locked out of their own club's tools.
function needsSecondAdmin(samePerson: boolean, adminCount: number, soloConfirmed: boolean): boolean {
  if (!samePerson) return false;
  if (adminCount > 1) return true;
  return !soloConfirmed;
}

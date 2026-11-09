// =============================================================================
// pending_change.ts — a change a second board member approves (PLAN.md CQ2, CQ3)
// =============================================================================
// Doug 11/8: "Should we have something that has 2 people on the board that
// need to reply? So it's extra secure?". Switching the club's Stripe account,
// changing where Venmo payments go, and giving someone full access wait here
// until the Treasurer or anyone else with full access approves (with their
// own texted code, _shared/step_up.ts). Until then nothing changes, so
// payments keep going to the current account. A request lasts 7 days.
// When there's nobody else on the board (a club still being set up), the
// asker's own texted code is enough and it happens at once; nothing goes to
// Poolside (Doug 11/8: "Do everything the same Minus message goes to
// poolside. If I'm the only person, I can get a text code and it will work").
//
// Heads-up texts (CQ2): every full-access board member hears when one of
// these is asked for, approved or stopped, and when someone texts every
// member or downloads every household (headsUp).
// =============================================================================

type Db = { from: (table: string) => any };   // a Supabase client, or the tests' pretend one

export type ChangeKind = 'stripe_switch' | 'payments_change' | 'full_access';
export type Change = {
  id: string; tenant_id: string; kind: ChangeKind; target_admin_id: string | null; payload: Record<string, unknown>;
  summary: string; requested_by: string | null; status: string; expires_at: string; created_at: string;
  decided_by?: string | null; decided_by_poolside?: boolean; decided_at?: string | null;
};

// How texts and emails go out; tests swap these.
export const notifyDeps = {
  async sms(sb: Db, tenantId: string, to: string, body: string, source: string): Promise<boolean> {
    try {
      const { sendSms } = await import('./send_sms.ts');
      return (await sendSms({ sb: sb as never, tenantId, to, body, kind: 'transactional', source })).sent;
    } catch (e) { console.error('pending change text:', (e as Error).message); return false; }
  },
};

const isOwner = (a: Record<string, unknown>) => a.is_super === true || a.role_template === 'owner' || (Array.isArray(a.roles) && (a.roles as string[]).includes('owner'));
const isGate = (a: Record<string, unknown>) => a.role_template === 'gate_attendant' || (Array.isArray(a.roles) && (a.roles as string[]).length > 0 && (a.roles as string[]).every(r => r === 'gate_attendant'));

async function boardLogins(sb: Db, tenantId: string): Promise<Array<Record<string, unknown>>> {
  const { data } = await sb.from('admin_users').select('id, display_name, email, phone_e164, role_template, roles, is_super, active').eq('tenant_id', tenantId).eq('active', true);
  return ((data ?? []) as Array<Record<string, unknown>>).filter(a => !isGate(a));
}

/** Everyone with full access, for heads-up texts. */
export async function fullAccessLogins(sb: Db, tenantId: string): Promise<Array<Record<string, unknown>>> {
  return (await boardLogins(sb, tenantId)).filter(isOwner);
}

/** Who can approve: the Treasurer or anyone else with full access, never the one who asked. */
export async function approversFor(sb: Db, tenantId: string, exceptId: string | null): Promise<Array<Record<string, unknown>>> {
  const logins = await boardLogins(sb, tenantId);
  const { data: pos } = await sb.from('board_positions').select('id, slug').eq('tenant_id', tenantId).eq('slug', 'treasurer');
  const posIds = ((pos ?? []) as Array<{ id: string }>).map(p => p.id);
  const { data: holders } = posIds.length
    ? await sb.from('board_position_holders').select('admin_user_id, position_id').in('position_id', posIds)
    : { data: [] };
  const treasurers = new Set(((holders ?? []) as Array<{ admin_user_id: string }>).map(h => h.admin_user_id));
  return logins.filter(a => a.id !== exceptId && (isOwner(a) || treasurers.has(String(a.id))));
}

const nameOf = (a: Record<string, unknown> | undefined) => String(a?.display_name || a?.email || 'A board member');

/** A heads-up text to every full-access board member (except `except`). */
export async function headsUp(sb: Db, args: { tenantId: string; text: string; except?: Array<string | null>; source?: string }): Promise<number> {
  const skip = new Set((args.except ?? []).filter(Boolean) as string[]);
  let n = 0;
  for (const a of await fullAccessLogins(sb, args.tenantId)) {
    if (skip.has(String(a.id)) || !a.phone_e164) continue;
    if (await notifyDeps.sms(sb, args.tenantId, String(a.phone_e164), args.text, args.source ?? 'heads_up')) n++;
  }
  return n;
}

async function club(sb: Db, tenantId: string): Promise<{ name: string; slug: string }> {
  const { data } = await sb.from('tenants').select('display_name, slug').eq('id', tenantId).maybeSingle();
  return { name: String(data?.display_name ?? 'Your club'), slug: String(data?.slug ?? '') };
}

/** Ask for a change. A second ask of the same kind (for the same person) replaces the first. */
export async function requestChange(sb: Db, args: {
  tenantId: string; kind: ChangeKind; summary: string; payload?: Record<string, unknown>;
  targetAdminId?: string | null; requestedBy: string | null;
}): Promise<{ id: string; approvers: number; applied: boolean }> {
  const now = new Date().toISOString();
  const approvers = await approversFor(sb, args.tenantId, args.requestedBy);
  const { data: open } = await sb.from('pending_changes').select('id, target_admin_id').eq('tenant_id', args.tenantId)
    .eq('kind', args.kind).eq('status', 'waiting');
  for (const o of ((open ?? []) as Array<{ id: string; target_admin_id: string | null }>)) {
    if ((o.target_admin_id ?? null) === (args.targetAdminId ?? null)) {
      await sb.from('pending_changes').update({ status: 'cancelled', decided_at: now }).eq('id', o.id);
      await sb.from('admin_tasks').update({ completed_at: now }).eq('tenant_id', args.tenantId).eq('source_kind', 'pending_change').eq('source_id', o.id).is('completed_at', null);
    }
  }
  const { data: row } = await sb.from('pending_changes').insert({
    tenant_id: args.tenantId, kind: args.kind, summary: args.summary, payload: args.payload ?? {},
    target_admin_id: args.targetAdminId ?? null, requested_by: args.requestedBy, status: approvers.length ? 'waiting' : 'approved',
    ...(approvers.length ? {} : { decided_by: args.requestedBy, decided_at: now }),
    expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), created_at: now,
  }).select('id').single();
  const id = String(row?.id);
  const c = await club(sb, args.tenantId);
  const logins = await boardLogins(sb, args.tenantId);
  const who = nameOf(logins.find(a => a.id === args.requestedBy));
  // Nobody else on the board: their own code (already checked) is enough.
  if (!approvers.length) {
    const err = await apply(sb, { id, tenant_id: args.tenantId, kind: args.kind, target_admin_id: args.targetAdminId ?? null, payload: args.payload ?? {},
      summary: args.summary, requested_by: args.requestedBy, status: 'approved', expires_at: now, created_at: now }, args.requestedBy);
    try {
      await sb.from('audit_log').insert({ tenant_id: args.tenantId, kind: 'change.approved', entity_type: 'pending_change', entity_id: id,
        summary: `${who}: ${args.summary}, with a texted code (nobody else on the board to approve)${err ? `. It didn't go through: ${err}` : ''}`, actor_id: args.requestedBy, actor_kind: 'tenant_admin' });
    } catch { /* done either way */ }
    return { id, approvers: 0, applied: !err };
  }
  const link = `https://${c.slug}.poolsideapp.com/club/admin/#approve=${id}`;
  const { enqueueAdminTask } = await import('./enqueue_task.ts');
  for (const a of approvers) {
    try {
      await enqueueAdminTask(sb as never, {
        tenant_id: args.tenantId, target_scopes: [], assigned_admin_id: String(a.id), kind: 'change.approve',
        summary: `Approve or stop: ${who} asked to ${args.summary}`,
        link_url: `/club/admin/#approve=${id}`, source_kind: 'pending_change', source_id: id,
        push_title: '🔐 A change needs your OK',
      });
    } catch (e) { console.error('approval to-do:', (e as Error).message); }
    if (a.phone_e164) await notifyDeps.sms(sb, args.tenantId, String(a.phone_e164),
      `${c.name}: ${who} asked to ${args.summary}. Nothing changes until a second board member approves. Approve or stop it: ${link}`, 'pending_change.ask');
  }
  // Everyone else with full access hears about it too (approvers already did).
  const told = new Set(approvers.map(a => String(a.id)));
  await headsUp(sb, { tenantId: args.tenantId, text: `${c.name}: heads-up, ${who} asked to ${args.summary}. If that's wrong, call them.`,
    except: [args.requestedBy, ...told], source: 'pending_change.heads_up' });
  try {
    await sb.from('audit_log').insert({ tenant_id: args.tenantId, kind: 'change.requested', entity_type: 'pending_change', entity_id: id,
      summary: `${who} asked to ${args.summary}`, actor_id: args.requestedBy, actor_kind: 'tenant_admin' });
  } catch { /* the request stands */ }
  return { id, approvers: approvers.length, applied: false };
}

/** The club's changes still waiting, for the pages' banners. */
export async function waitingChanges(sb: Db, tenantId: string): Promise<Change[]> {
  const { data } = await sb.from('pending_changes').select('*').eq('tenant_id', tenantId).eq('status', 'waiting');
  const now = new Date().toISOString();
  return ((data ?? []) as Change[]).filter(c => c.expires_at > now).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Make the change itself, once approved. */
async function apply(sb: Db, c: Change, actor: string | null): Promise<string | null> {
  if (c.kind === 'stripe_switch') {
    const { data: t } = await sb.from('tenants').select('id, stripe_account_id').eq('id', c.tenant_id).maybeSingle();
    if (t?.stripe_account_id && (!c.payload.from_account || t.stripe_account_id === c.payload.from_account)) {
      await sb.from('tenants').update({ stripe_account_id: null, stripe_charges_enabled: false, stripe_payouts_enabled: false }).eq('id', c.tenant_id);
      await sb.from('audit_log').insert({ tenant_id: c.tenant_id, kind: 'stripe.account_switched', entity_type: 'tenant', entity_id: c.tenant_id,
        summary: `Stripe account ${t.stripe_account_id} set aside: the club is connecting a different account (approved)`, actor_id: actor, actor_kind: 'tenant_admin' });
    }
    return null;
  }
  if (c.kind === 'payments_change') {
    const { data: s } = await sb.from('settings').select('value').eq('tenant_id', c.tenant_id).maybeSingle();
    const value = (s?.value ?? {}) as Record<string, unknown>;
    const payments = { ...((value.payments ?? {}) as Record<string, unknown>) };
    for (const k of ['venmo_handle', 'paypal_link']) if (k in c.payload) payments[k] = c.payload[k] ?? null;
    if (s) await sb.from('settings').update({ value: { ...value, payments } }).eq('tenant_id', c.tenant_id);
    else await sb.from('settings').insert({ tenant_id: c.tenant_id, value: { payments } });
    return null;
  }
  if (c.kind === 'full_access') {
    const { data: a } = await sb.from('admin_users').select('id, active').eq('id', c.target_admin_id).eq('tenant_id', c.tenant_id).maybeSingle();
    if (!a || a.active === false) return 'They are no longer on the board.';
    await sb.from('admin_users').update({ role_template: 'owner', roles: ['owner'], scopes: [] }).eq('id', c.target_admin_id).eq('tenant_id', c.tenant_id);
    return null;
  }
  return 'Unknown change';
}

/** Approve or stop. `by` is a board login, or null with `poolside` for the provider console. */
export async function decideChange(sb: Db, args: {
  id: string; tenantId: string | null; by: string | null; poolside?: boolean; approve: boolean;
}): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  let q = sb.from('pending_changes').select('*').eq('id', args.id);
  if (args.tenantId) q = q.eq('tenant_id', args.tenantId);
  const { data: c } = await q.maybeSingle() as { data: Change | null };
  if (!c) return { ok: false, error: "That change isn't here." };
  if (c.status !== 'waiting') return { ok: false, error: `It was already ${c.status}.` };
  const now = new Date().toISOString();
  if (c.expires_at <= now) {
    await sb.from('pending_changes').update({ status: 'expired', decided_at: now }).eq('id', c.id);
    return { ok: false, error: 'It waited more than 7 days, so it expired. Ask again.' };
  }
  // The one who asked can take it back, never approve it.
  const own = !args.poolside && args.by === c.requested_by;
  if (own && args.approve) return { ok: false, error: 'A second board member has to approve it, not the one who asked.' };
  if (!args.poolside && !own) {
    const ok = (await approversFor(sb, c.tenant_id, c.requested_by)).some(a => a.id === args.by);
    if (!ok) return { ok: false, error: 'Only the Treasurer or someone with full access can approve this.' };
  }
  if (args.approve) {
    const err = await apply(sb, c, args.by);
    if (err) return { ok: false, error: err };
  }
  const status = args.approve ? 'approved' : own ? 'cancelled' : 'stopped';
  await sb.from('pending_changes').update({ status, decided_by: args.by, decided_by_poolside: !!args.poolside, decided_at: now }).eq('id', c.id);
  await sb.from('admin_tasks').update({ completed_at: now }).eq('tenant_id', c.tenant_id).eq('source_kind', 'pending_change').eq('source_id', c.id).is('completed_at', null);
  const cl = await club(sb, c.tenant_id);
  const logins = await boardLogins(sb, c.tenant_id);
  const by = args.poolside ? 'Poolside' : nameOf(logins.find(a => a.id === args.by));
  const asker = logins.find(a => a.id === c.requested_by);
  const what = status === 'approved' ? 'approved' : status === 'cancelled' ? 'took back' : 'stopped';
  const text = `${cl.name}: ${by} ${what} the request to ${c.summary}.`;
  if (asker?.phone_e164 && !own) await notifyDeps.sms(sb, c.tenant_id, String(asker.phone_e164), text, 'pending_change.decided');
  await headsUp(sb, { tenantId: c.tenant_id, text, except: [args.by, c.requested_by], source: 'pending_change.heads_up' });
  try {
    await sb.from('audit_log').insert({ tenant_id: c.tenant_id, kind: `change.${status}`, entity_type: 'pending_change', entity_id: c.id,
      summary: `${by} ${what} the request to ${c.summary}`, actor_id: args.by, actor_kind: args.poolside ? 'provider' : 'tenant_admin' });
  } catch { /* decided either way */ }
  return { ok: true, status };
}

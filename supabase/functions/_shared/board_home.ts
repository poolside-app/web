// =============================================================================
// board_home.ts — each board member's home page, from the ticks (PLAN.md W)
// =============================================================================
// Doug, 10/9: "a layout per board member… the president can pick and choose
// what each board member can see… the page comes from the ticks." Whatever
// the President ticks for a position on Settings → Board (its screens and
// its alerts) decides that person's home:
//   - the three numbers on the banner and the four quick buttons come from
//     the screens they can use, here;
//   - "Needs you" is their dashboard tasks, routed by _shared/task_routing.ts.
// The President (full access) sees the club-wide set. Someone holding two
// positions gets some of each. Nothing here is stored: a changed tick shows
// the next time the page opens, because scopes are read from the database.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sellingYear } from './membership_year.ts';
import { poolDayBounds } from './pool_time.ts';
import { duesTotals } from './dues_totals.ts';
import { bridgeOnline } from './bridge_health.ts';

export type HomeCaller = { id: string; isOwner: boolean; scopes: string[] };
export type HeldPosition = { scopes?: string[] | null };
type Features = Record<string, unknown>;

/** Areas of the board's work, in the order they win a tie. */
export const AREA_ORDER = ['money', 'members', 'gate', 'calendar', 'content'] as const;
type Area = typeof AREA_ORDER[number] | 'any';
export const AREA_SCOPES: Record<Exclude<Area, 'any'>, string[]> = {
  money: ['payments', 'tiers'],
  members: ['applications', 'households', 'renewals'],
  gate: ['keyfobs', 'check_in', 'shifts'],
  calendar: ['events', 'parties', 'programs', 'volunteer'],
  content: ['announcements', 'photos', 'meetings', 'policies', 'audit'],
};

/** One number or one button. `needs`: any one of these screens (none: anyone
 *  on the board). `feature`: a club feature that must be on; `optIn` ones
 *  are off unless turned on, the rest are on unless turned off. */
export type HomeItem = {
  key: string; area: Area; needs: string[]; label: string; href: string;
  icon?: string; feature?: string; optIn?: boolean;
};

export const STATS: HomeItem[] = [
  { key: 'collected', area: 'money', needs: ['payments'], label: 'collected', href: '/club/admin/payments.html' },
  { key: 'owed', area: 'money', needs: ['payments'], label: 'still owed', href: '/club/admin/upcoming.html' },
  { key: 'on_plan', area: 'money', needs: ['payments'], label: 'on a plan', href: '/club/admin/payments.html' },
  // Every page's dues bar shows this to the whole board already.
  { key: 'paid', area: 'members', needs: [], label: 'families paid', href: '/club/admin/members.html' },
  { key: 'signups', area: 'members', needs: ['applications'], label: 'signups waiting', href: '/club/admin/members.html#applications' },
  { key: 'renewals_left', area: 'members', needs: ['households', 'renewals'], label: 'still to renew', href: '/club/admin/members.html#renewals' },
  { key: 'checkins', area: 'gate', needs: ['check_in'], label: 'check-ins today', href: '/club/admin/checkin.html' },
  { key: 'fobs_to_make', area: 'gate', needs: ['keyfobs'], feature: 'keyfobs', optIn: true, label: 'keyfobs to make', href: '/club/admin/keyfobs.html' },
  { key: 'fobs_in_use', area: 'gate', needs: ['keyfobs'], feature: 'keyfobs', optIn: true, label: 'keyfobs in use', href: '/club/admin/keyfobs.html' },
  { key: 'shifts_today', area: 'gate', needs: ['shifts'], feature: 'lifeguard_scheduling', optIn: true, label: 'lifeguard shifts today', href: '/club/admin/lifeguards.html' },
  { key: 'parties_week', area: 'calendar', needs: ['parties'], feature: 'parties', label: 'parties this week', href: '/club/admin/parties.html' },
  { key: 'events_week', area: 'calendar', needs: ['events'], label: 'events this week', href: '/club/admin/events.html' },
  { key: 'programs', area: 'calendar', needs: ['programs'], feature: 'programs', label: 'programs running', href: '/club/admin/programs.html' },
  { key: 'photos_waiting', area: 'content', needs: ['photos'], label: 'photos to approve', href: '/club/admin/photos.html#pending' },
  { key: 'questions', area: 'any', needs: [], label: 'member questions for you', href: '/club/admin/member-help.html' },
  { key: 'next_meeting', area: 'any', needs: [], label: 'next board meeting', href: '/club/admin/board-meetings.html' },
];

export const QUICK: HomeItem[] = [
  { key: 'upcoming', area: 'money', needs: ['payments'], icon: '📆', label: 'Upcoming payments', href: '/club/admin/upcoming.html' },
  { key: 'payments', area: 'money', needs: ['payments'], icon: '💵', label: 'Payments', href: '/club/admin/payments.html' },
  { key: 'signups', area: 'members', needs: ['applications'], icon: '📝', label: 'Signups', href: '/club/admin/members.html#applications' },
  { key: 'member_list', area: 'members', needs: ['households'], icon: '👪', label: 'Member list', href: '/club/admin/members.html#households' },
  { key: 'renewals', area: 'members', needs: ['households', 'renewals'], icon: '🔁', label: 'Renewals', href: '/club/admin/members.html#renewals' },
  { key: 'keyfobs', area: 'gate', needs: ['keyfobs'], feature: 'keyfobs', optIn: true, icon: '🔑', label: 'Keyfobs', href: '/club/admin/keyfobs.html' },
  { key: 'checkin', area: 'gate', needs: ['check_in'], icon: '✅', label: 'Check-in', href: '/club/admin/checkin.html' },
  { key: 'shifts', area: 'gate', needs: ['shifts'], feature: 'lifeguard_scheduling', optIn: true, icon: '🛟', label: 'Lifeguard shifts', href: '/club/admin/lifeguards.html' },
  { key: 'add_event', area: 'calendar', needs: ['events'], icon: '📅', label: 'Add an event', href: '/club/admin/events.html#new' },
  { key: 'parties', area: 'calendar', needs: ['parties'], feature: 'parties', icon: '🎉', label: 'Parties', href: '/club/admin/parties.html' },
  { key: 'programs', area: 'calendar', needs: ['programs'], feature: 'programs', icon: '🏊', label: 'Programs', href: '/club/admin/programs.html' },
  { key: 'volunteer', area: 'calendar', needs: ['volunteer'], feature: 'volunteer', icon: '🙋', label: 'Volunteers', href: '/club/admin/volunteer.html' },
  { key: 'text_all', area: 'content', needs: ['announcements'], icon: '📱', label: 'Text all members', href: '/club/admin/announcements.html#text' },
  { key: 'post_news', area: 'content', needs: ['announcements'], icon: '📣', label: 'Post news', href: '/club/admin/announcements.html#new' },
  { key: 'add_photos', area: 'content', needs: ['photos'], icon: '📷', label: 'Add photos', href: '/club/admin/photos.html#upload' },
  { key: 'policies', area: 'content', needs: ['policies'], icon: '📜', label: 'Policies', href: '/club/admin/policies.html' },
  { key: 'member_help', area: 'any', needs: [], icon: '💬', label: 'Member help', href: '/club/admin/member-help.html' },
  { key: 'agenda', area: 'any', needs: [], icon: '🗒️', label: 'Add to the agenda', href: '/club/admin/board-meetings.html#add' },
  { key: 'board', area: 'any', needs: [], icon: '👥', label: 'The board', href: '/club/admin/board.html' },
  { key: 'guides', area: 'any', needs: [], icon: '❓', label: 'Help and guides', href: '/club/admin/help.html' },
];

const OWNER_STATS = ['paid', 'collected', 'on_plan'];
const FALLBACK_STATS = ['questions', 'next_meeting', 'paid'];
const OWNER_QUICK = ['text_all', 'post_news', 'add_event', 'add_photos'];
const FALLBACK_QUICK = ['member_help', 'agenda', 'board', 'guides'];

function featureOn(item: HomeItem, features: Features): boolean {
  if (!item.feature) return true;
  const v = features[item.feature];
  return item.optIn ? !!v : v !== false;
}
function allowed(item: HomeItem, caller: HomeCaller, features: Features): boolean {
  if (!featureOn(item, features)) return false;
  return caller.isOwner || !item.needs.length || item.needs.some(s => caller.scopes.includes(s));
}
function primaryArea(scopes: string[]): Area | null {
  return AREA_ORDER.find(a => AREA_SCOPES[a].some(s => scopes.includes(s))) ?? null;
}

/** The areas a person works in: each position's main one first (in the
 *  order they hold them), then any other they have screens for. */
export function areasFor(caller: HomeCaller, held: HeldPosition[]): { primary: Area[]; rest: Area[] } {
  const groups = held.length ? held.map(p => p.scopes ?? []) : [caller.scopes];
  const primary = [...new Set(groups.map(primaryArea).filter(Boolean) as Area[])];
  const rest = AREA_ORDER.filter(a => !primary.includes(a) && AREA_SCOPES[a].some(s => caller.scopes.includes(s)));
  return { primary, rest };
}

function pick(catalog: HomeItem[], n: number, ownerKeys: string[], fallbackKeys: string[],
  caller: HomeCaller, held: HeldPosition[], features: Features): string[] {
  const ok = (k: string) => { const it = catalog.find(i => i.key === k); return !!it && allowed(it, caller, features); };
  const inArea = (a: Area) => catalog.filter(i => i.area === a && allowed(i, caller, features)).map(i => i.key);
  const out: string[] = [];
  const add = (k: string) => { if (out.length < n && !out.includes(k)) out.push(k); };
  if (caller.isOwner) ownerKeys.filter(ok).forEach(add);
  const { primary, rest } = areasFor(caller, held);
  // Two positions: take turns, so each one gets its first number.
  const lists = primary.map(inArea);
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (l[i]) add(l[i]);
  for (const a of rest) inArea(a).forEach(add);
  fallbackKeys.filter(ok).forEach(add);
  for (const a of AREA_ORDER) inArea(a).forEach(add);   // an owner whose usual set is off
  return out;
}

/** The three numbers on this person's banner. */
export function pickStats(caller: HomeCaller, held: HeldPosition[], features: Features): string[] {
  return pick(STATS, 3, OWNER_STATS, FALLBACK_STATS, caller, held, features);
}
/** The four quick buttons. */
export function pickQuick(caller: HomeCaller, held: HeldPosition[], features: Features): string[] {
  return pick(QUICK, 4, OWNER_QUICK, FALLBACK_QUICK, caller, held, features);
}
/** The signup link is for whoever handles signups. */
export function showSignupLink(caller: HomeCaller): boolean {
  return caller.isOwner || caller.scopes.includes('applications') || caller.scopes.includes('households');
}
/** The gate unlock at the top of the home: only when the club has keyfobs
 *  and remote unlock on and the panel is set up. `online`: the bridge is
 *  answering, so a tap would open the gate now. */
export type GatePanel = { status?: string | null; panel_host?: string | null; bridge_last_seen_at?: string | null };
export function gateCard(features: Features, panel: GatePanel | null, _caller: HomeCaller): { show: boolean; online: boolean } {
  // Every board member (Doug, 10/9), not only the President.
  const show = !!features.keyfobs && !!features.gate && !!panel && panel.status === 'active' && !!panel.panel_host;
  return { show, online: show && bridgeOnline(panel?.bridge_last_seen_at ?? null) };
}

/** May they see family names on parties? Otherwise "Private party". */
const seesParties = (c: HomeCaller) => c.isOwner || c.scopes.includes('parties');

const addDays = (key: string, n: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

export type HomeStat = { key: string; label: string; href: string; value: number | string | null; money?: boolean };

/**
 * Everything the home page shows besides the tasks, in one call. Only the
 * numbers this person gets are counted.
 */
export async function loadHome(sb: SupabaseClient, ctx: {
  tenantId: string; tz: string; settingsValue: Record<string, unknown>;
  caller: HomeCaller; held: HeldPosition[]; tasks: Array<{ kind: string }>;
}) {
  const { tenantId: T, tz, settingsValue: sv, caller } = ctx;
  const features = (sv.features ?? {}) as Features;
  const season = sellingYear(sv);
  const day = poolDayBounds(new Date(), tz);
  const today = day.key;
  const weekEnd = addDays(today, 6);
  const statKeys = pickStats(caller, ctx.held, features);
  const quickKeys = pickQuick(caller, ctx.held, features);
  const wants = (k: string) => statKeys.includes(k);
  const count = async (q: PromiseLike<{ count: number | null }>) => (await q).count ?? 0;

  // Plans still running: the money numbers and the next charge day.
  const moneyPerson = caller.isOwner || caller.scopes.includes('payments');
  const plansQ = (wants('owed') || wants('on_plan') || moneyPerson)
    ? sb.from('payment_plans').select('id').eq('tenant_id', T).in('status', ['active', 'past_due']).limit(1000)
    : Promise.resolve({ data: [] as { id: string }[] });

  const [dues, plansRes, nextMeeting, panel] = await Promise.all([
    (wants('paid') || wants('collected')) ? duesTotals(sb, T, sv) : Promise.resolve(null),
    plansQ,
    sb.from('board_meetings').select('id, title, meeting_date, planned_time, agenda_created_at')
      .eq('tenant_id', T).eq('status', 'draft').gte('meeting_date', today)
      .order('meeting_date').order('created_at').limit(1).then(r => (r.data ?? [])[0] ?? null),
    (features.gate && features.keyfobs)
      ? sb.from('gate_panels').select('status, panel_host, bridge_last_seen_at').eq('tenant_id', T).maybeSingle().then(r => r.data as GatePanel | null)
      : Promise.resolve(null),
  ]);
  const planIds = ((plansRes as { data: { id: string }[] | null }).data ?? []).map(p => p.id);
  const unpaid = planIds.length
    ? ((await sb.from('payment_plan_installments').select('plan_id, due_date, amount_cents, status, approved_at')
        .in('plan_id', planIds).in('status', ['pending', 'retrying', 'failed']).order('due_date').limit(5000)).data ?? [])
    : [];

  const value: Record<string, number | string | null> = {};
  const jobs: Promise<void>[] = [];
  const job = (k: string, f: () => Promise<number | string | null>) => { if (wants(k)) jobs.push(f().then(v => { value[k] = v; })); };
  job('paid', async () => dues?.paid ?? 0);
  job('collected', async () => dues?.collected_cents ?? 0);
  job('owed', async () => unpaid.reduce((n, r) => n + Number(r.amount_cents ?? 0), 0));
  job('on_plan', async () => planIds.length);
  job('signups', () => count(sb.from('applications').select('id', { count: 'exact', head: true }).eq('tenant_id', T)
    .or('status.eq.pending,and(status.eq.approved,payment_status.in.("unpaid","pending"))')));
  job('renewals_left', () => count(sb.from('households').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).eq('active', true).eq('paid_until_year', season - 1)));
  job('checkins', () => count(sb.from('pool_checkins').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).gte('checked_in_at', day.startIso).lt('checked_in_at', day.endIso)));
  job('fobs_to_make', () => count(sb.from('keyfobs').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).eq('status', 'requested').neq('payment_status', 'unpaid')));
  job('fobs_in_use', () => count(sb.from('keyfobs').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).eq('status', 'active')));
  job('shifts_today', () => count(sb.from('lifeguard_shifts').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).gte('starts_at', day.startIso).lt('starts_at', day.endIso)));
  job('parties_week', () => count(sb.from('party_bookings').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).eq('status', 'approved').gte('pool_date', today).lte('pool_date', weekEnd)));
  job('events_week', async () => null);   // counted on the page, which expands repeating events
  job('programs', () => count(sb.from('programs').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).eq('active', true).or(`end_date.is.null,end_date.gte.${today}`)));
  job('photos_waiting', () => count(sb.from('photos').select('id', { count: 'exact', head: true })
    .eq('tenant_id', T).eq('status', 'pending')));
  job('questions', async () => ctx.tasks.filter(t => t.kind === 'help.request').length);
  job('next_meeting', async () => (nextMeeting?.meeting_date as string | undefined) ?? null);

  // Today at the pool and the week ahead. Repeating events are expanded on
  // the page (js/today.js), so send the ones that could land this week.
  const [events, programs, parties, shifts] = await Promise.all([
    sb.from('events').select('id, title, kind, location, starts_at, ends_at, all_day, recurrence, recurrence_until')
      .eq('tenant_id', T).eq('active', true).neq('kind', 'meeting')
      .or(`and(starts_at.gte.${addDays(today, -14)},starts_at.lte.${addDays(today, 8)}),and(recurrence.not.is.null,or(recurrence_until.is.null,recurrence_until.gte.${today}))`)
      .order('starts_at').limit(300).then(r => r.data ?? []),
    sb.from('programs').select('id, name, weekdays, start_time, end_time, start_date, end_date, location')
      .eq('tenant_id', T).eq('active', true).limit(100).then(r => r.data ?? []),
    features.parties === false ? Promise.resolve([]) :
      sb.from('party_bookings').select('id, title, starts_at, ends_at, status, payment_status, pool_date, households(family_name)')
        .eq('tenant_id', T).in('status', seesParties(caller) ? ['approved', 'pending'] : ['approved'])
        .gte('pool_date', today).lte('pool_date', weekEnd).order('starts_at').limit(50).then(r => r.data ?? []),
    (features.lifeguard_scheduling && (caller.isOwner || caller.scopes.includes('shifts')))
      ? sb.from('lifeguard_shifts').select('id, starts_at, ends_at, position, spots_needed, lifeguard_signups(status)')
          .eq('tenant_id', T).gte('starts_at', day.startIso).lt('starts_at', day.endIso).order('starts_at').then(r => r.data ?? [])
      : Promise.resolve([]),
  ]);
  await Promise.all(jobs);

  // The next day plan payments come due, for whoever handles money: how
  // many, how much, and how many still need a tick (PLAN.md S).
  let charge_day: { date: string; count: number; cents: number; waiting: number } | null = null;
  if (moneyPerson && unpaid.length) {
    const date = String(unpaid[0].due_date);
    const rows = unpaid.filter(r => String(r.due_date) === date);
    if (date <= addDays(today, 30)) {
      charge_day = { date, count: rows.length, cents: rows.reduce((n, r) => n + Number(r.amount_cents ?? 0), 0),
        waiting: rows.filter(r => !r.approved_at).length };
    }
  }

  const pool = (sv.pool ?? {}) as Record<string, unknown>;
  const lat = Number(pool.lat), lng = Number(pool.lng);
  const seasonSv = (sv.season ?? {}) as Record<string, unknown>;
  const byKey = (cat: HomeItem[], k: string) => cat.find(i => i.key === k)!;
  return {
    season, today,
    stats: statKeys.map(k => {
      const s = byKey(STATS, k);
      return { key: k, label: s.label, href: s.href, value: value[k] ?? null, money: k === 'collected' || k === 'owed' } as HomeStat;
    }),
    quick: quickKeys.map(k => { const q = byKey(QUICK, k); return { key: k, icon: q.icon, label: q.label, href: q.href }; }),
    signup_link: showSignupLink(caller),
    gate: gateCard(features, panel, caller),
    pool: { opens_at: pool.opens_at ?? null, closes_at: pool.closes_at ?? null, hours_by_day: pool.hours_by_day ?? null,
      location: Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng) ? { lat, lng } : null },
    season_open: seasonSv.open !== false,
    closed_message: typeof seasonSv.closed_message === 'string' ? seasonSv.closed_message : null,
    events, programs, shifts,
    parties: (parties as Array<Record<string, unknown>>).map(p => ({
      id: p.id, starts_at: p.starts_at, ends_at: p.ends_at, status: p.status, pool_date: p.pool_date,
      title: seesParties(caller) ? (p.title || 'Party') : 'Private party',
      family: seesParties(caller) ? ((p.households as { family_name?: string } | null)?.family_name ?? null) : null,
      paid: p.payment_status === 'paid',
    })),
    next_meeting: nextMeeting ? { id: nextMeeting.id, title: nextMeeting.title, date: nextMeeting.meeting_date,
      time: nextMeeting.planned_time ?? null, agenda: !!nextMeeting.agenda_created_at } : null,
    charge_day,
  };
}

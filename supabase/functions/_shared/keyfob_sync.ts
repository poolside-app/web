// =============================================================================
// keyfob_sync.ts — putting Poolside's keyfobs on the doors (PLAN.md AS4, P5)
// =============================================================================
// Doug, 10/13: "check first, then send"; nightly plus a button; the nightly
// one only when his "Auto keyfob activations" switch is on (off for now).
//
// The controllers (UHPPOTE-type) keep, per card: valid-from and -until
// dates and, for each of their 4 doors, 0 (no), 1 (any time) or a time
// window's number (2-254). Each controller also keeps the time windows:
// dates, weekdays, and hours. Bishop's old program already uses window 2
// for "Members" (6:00 AM-8:30 PM) and gives the board 1 or window 3.
//
//   syncPlan  what Poolside wants on each controller, for the fobs it
//             manages: active fobs on their level's doors, dates and hours;
//             turned-off and lost fobs off. Cards Poolside doesn't manage
//             are never in the plan, so they're never touched. A Member fob
//             is on only while the season is open and its family may use
//             the gate (PLAN.md BE1, Doug 10/19: "when we close the season,
//             we need to shut the keyfobs off…. NOT the board members").
//   diffSync  what the gate computer read vs the plan: the writes to make
//             (a card's keypad PIN is kept) and a plain summary.
// Level i (in settings order) uses window 2+i when it has hours or isn't
// every day; a level open any time, every day, uses 1.
// =============================================================================

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { doorsFor } from './gate_doors.ts';
import { accessConfig, type AccessConfig, type Level } from './access.ts';

export type CardWant = { from: string; to: string; doors: number[] };
export type CardHave = CardWant & { pin: number };
export type ProfileWant = { from: string; to: string; days: boolean[]; start: string; end: string };
export type SyncPlan = {
  controllers: Array<{ serial: number; address: string; name?: string }>;
  // `why`: why a fob that's still active comes off ("the season is closed").
  cards: Array<{ card: number; controller: number; fob_id: string; family: string | null; level: string; want: CardWant | null; why?: string }>;
  profiles: Array<{ controller: number; id: number; level: string; want: ProfileWant }>;
};
export type SyncHave = {
  // `error`: the gate computer couldn't read it. Then nothing is written for
  // it, so an unreachable controller never looks like an empty one.
  cards: Array<{ card: number; controller: number; have: CardHave | null; error?: string }>;
  profiles: Array<{ controller: number; id: number; have: ProfileWant | null; error?: string }>;
};
export type SyncOp =
  | { op: 'put'; controller: number; card: number; from: string; to: string; doors: number[]; pin: number }
  | { op: 'delete'; controller: number; card: number }
  | { op: 'profile'; controller: number; id: number } & ProfileWant;

const EARLIEST = '2020-01-01', LATEST = '2099-12-31';

/** Can this gate computer read and write the controllers? 1.4 and later. */
export function syncReady(version: string | null | undefined): boolean {
  const m = String(version ?? '').match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 1 || (maj === 1 && min >= 4);
}

const needsWindow = (l: Level) => !!(l.start && l.end) || l.days.length < 7;

/** A level's value on a door it opens: 1 for any time, else its window. */
function doorValue(levels: Level[], level: Level): number {
  return needsWindow(level) ? 2 + levels.indexOf(level) : 1;
}

// The season and the families who may use the gate (gateHouseholds), for
// Member fobs. Left out, every active fob is on (the shape before BE1).
export type SyncGate = { seasonOpen: boolean; season: number; members: Set<string> };

export function syncPlan(a: { fobs: Array<Record<string, unknown>>; config: AccessConfig; doorsRaw: unknown; gate?: SyncGate }): SyncPlan {
  const doors = doorsFor(a.doorsRaw).filter(d => d.controller && d.door);
  const controllers: SyncPlan['controllers'] = [];
  // Named by its first door, for the board ("the Main Gate controller").
  for (const d of doors) if (!controllers.some(c => c.serial === d.controller)) controllers.push({ serial: d.controller as number, address: d.address as string, name: `the ${d.name} controller` });
  const levels = a.config.levels;
  const byKey = (k: unknown) => levels.find(l => l.key === k) ?? levels.find(l => l.key === 'member') ?? levels[0];

  // Turned-off and lost first, so an active fob with the same number wins.
  const wanted = new Map<string, SyncPlan['cards'][number]>();
  const order = (s: unknown) => (s === 'active' ? 1 : 0);
  const fobs = a.fobs.filter(f => f.card_number != null && ['active', 'off', 'lost'].includes(String(f.status)))
    .sort((x, y) => order(x.status) - order(y.status));
  for (const f of fobs) {
    const card = Number(f.card_number);
    const level = byKey(f.level);
    // Only the Member level depends on the season and on paying.
    const why = f.status !== 'active' || level?.key !== 'member' || !a.gate ? undefined
      : !a.gate.seasonOpen ? 'the season is closed'
      : !a.gate.members.has(String(f.household_id)) ? `not paid for ${a.gate.season}` : undefined;
    for (const c of controllers) {
      let want: CardWant | null = null;
      if (f.status === 'active' && level && !why) {
        const v = doorValue(levels, level);
        const values = [1, 2, 3, 4].map(n => {
          const door = doors.find(d => d.controller === c.serial && d.door === n);
          return door && level.doors.includes(door.key) ? v : 0;
        });
        if (values.some(Boolean)) want = { from: level.from ?? EARLIEST, to: level.until ?? LATEST, doors: values };
      }
      wanted.set(`${card}@${c.serial}`, { card, controller: c.serial, fob_id: String(f.id), family: (f.family_name as string) ?? null, level: level?.key ?? 'member', want, ...(why ? { why } : {}) });
    }
  }

  const profiles: SyncPlan['profiles'] = [];
  for (const l of levels.filter(needsWindow)) {
    const want: ProfileWant = {
      from: l.from ?? EARLIEST, to: l.until ?? LATEST,
      days: [1, 2, 3, 4, 5, 6, 0].map(d => l.days.includes(d)),        // Monday first, as the controllers keep them
      start: l.start ?? '00:00', end: l.end ?? '23:59',
    };
    for (const c of controllers) profiles.push({ controller: c.serial, id: doorValue(levels, l), level: l.key, want });
  }
  return { controllers, cards: [...wanted.values()], profiles };
}

const sameCard = (w: CardWant, h: CardHave) => w.from === h.from && w.to === h.to && w.doors.length === h.doors.length && w.doors.every((x, i) => x === h.doors[i]);
const sameProfile = (w: ProfileWant, h: ProfileWant) => w.from === h.from && w.to === h.to && w.start === h.start && w.end === h.end && w.days.every((x, i) => x === h.days[i]);

export function diffSync(plan: SyncPlan, have: SyncHave): { ops: SyncOp[]; summary: { add: number; change: number; remove: number; profiles: number; unchanged: number; unreadable: number }; lines: string[] } {
  const ops: SyncOp[] = [];
  const summary = { add: 0, change: 0, remove: 0, profiles: 0, unchanged: 0, unreadable: 0 };
  const lines: string[] = [];
  const label = (serial: number) => plan.controllers.find(c => c.serial === serial)?.name ?? `controller ${String(serial).slice(-4)}`;
  const day = (s: string) => new Date(`${s}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const dates = (from: string, to: string) => from === EARLIEST && to === LATEST ? 'no end date' : to === LATEST ? `from ${day(from)}` : `${day(from)} to ${day(to)}`;
  const clock = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const cap = (k: string) => k[0].toUpperCase() + k.slice(1);
  for (const c of plan.cards) {
    const entry = have.cards.find(x => x.card === c.card && x.controller === c.controller);
    const who = `${c.family ?? 'Family'} · fob ${c.card}`;
    if (!entry || entry.error) { summary.unreadable++; lines.push(`${who}: couldn't be read on ${label(c.controller)}, left as is`); continue; }
    const h = entry.have ?? null;
    if (c.want && !h) {
      ops.push({ op: 'put', controller: c.controller, card: c.card, ...c.want, pin: 0 });
      summary.add++; lines.push(`${who}: add on ${label(c.controller)} (${cap(c.level)}, ${dates(c.want.from, c.want.to)})`);
    } else if (c.want && h && !sameCard(c.want, h)) {
      ops.push({ op: 'put', controller: c.controller, card: c.card, ...c.want, pin: h.pin ?? 0 });
      summary.change++; lines.push(`${who}: change on ${label(c.controller)} (${cap(c.level)}, ${dates(c.want.from, c.want.to)})`);
    } else if (!c.want && h) {
      ops.push({ op: 'delete', controller: c.controller, card: c.card });
      summary.remove++; lines.push(`${who}: turn off on ${label(c.controller)}${c.why ? ` (${c.why})` : ''}`);
    } else if (c.want && h) {
      summary.unchanged++;
    }
  }
  for (const p of plan.profiles) {
    const pe = have.profiles.find(x => x.controller === p.controller && x.id === p.id);
    if (!pe || pe.error) { summary.unreadable++; continue; }
    const h = pe.have ?? null;
    if (h && sameProfile(p.want, h)) continue;
    ops.push({ op: 'profile', controller: p.controller, id: p.id, ...p.want });
    summary.profiles++;
    lines.push(`${cap(p.level)} hours on ${label(p.controller)}: ${clock(p.want.start)}–${clock(p.want.end)}, ${dates(p.want.from, p.want.to)}`);
  }
  return { ops, summary, lines };
}

/** The plan for a club, from its fobs, levels and doors (the button and the nightly run share it). */
export async function loadSyncPlan(sb: SupabaseClient, tenantId: string): Promise<SyncPlan> {
  const [{ data: fobs }, { data: hhs }, { data: st }, { data: panel }] = await Promise.all([
    sb.from('keyfobs').select('id, household_id, card_number, status, level').eq('tenant_id', tenantId)
      .not('card_number', 'is', null).in('status', ['active', 'off', 'lost']).limit(5000),
    sb.from('households').select('id, family_name').eq('tenant_id', tenantId).limit(5000),
    sb.from('settings').select('value').eq('tenant_id', tenantId).maybeSingle(),
    sb.from('gate_panels').select('doors').eq('tenant_id', tenantId).maybeSingle(),
  ]);
  const fam = new Map((hhs ?? []).map(h => [h.id as string, h.family_name as string]));
  // Member fobs: the Season switch (Settings → Season) and who has paid.
  const { gateHouseholds } = await import('./membership_status.ts');
  const { sellingYear } = await import('./membership_year.ts');
  const sv = (st?.value ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const gate: SyncGate = { seasonOpen: sv.season?.open !== false, season: sellingYear(sv), members: await gateHouseholds(sb, tenantId) };
  return syncPlan({ fobs: (fobs ?? []).map(f => ({ ...f, family_name: fam.get(f.household_id as string) ?? null })),
    config: accessConfig(st?.value, panel?.doors ?? []), doorsRaw: panel?.doors ?? [], gate });
}

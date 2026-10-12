// =============================================================================
// gate_doors.ts — the doors Poolside can open (PLAN.md AK)
// =============================================================================
// Doug, 10/12: every board member can open every wired door from the board
// home; members open the front gate only. `gate_panels.doors` lists each
// door: its key, its name, its controller (serial and LAN address) and the
// door number on that controller. A club with no list has just the front
// gate, as before.
//
// The front gate (key 'main_gate') is opened the proven way, through the
// panel's web page (bridge/gate_bridge.py `unlock_panel`). Every other door
// is opened by the bridge straight through its controller (uhppoted
// `open_door`), which bridges before 1.2 can't do: an older bridge treats
// any unlock as the front gate, so it is never handed another door.
// =============================================================================

export type Door = { key: string; name: string; controller?: number; address?: string; door?: number };

export const MAIN_GATE = 'main_gate';
export const FRONT_GATE: Door = { key: MAIN_GATE, name: 'Front gate' };

/** For a bridge older than 1.2: claim only front-gate unlocks (a PostgREST `or`). */
export const OLD_BRIDGE_DOORS = `door_key.is.null,door_key.eq.${MAIN_GATE}`;

const KEY_RE = /^[a-z0-9_]{1,32}$/;
const ADDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d{1,5})?$/;

function validAddress(a: unknown): a is string {
  const m = typeof a === 'string' ? a.match(ADDR_RE) : null;
  return !!m && m.slice(1, 5).every(n => Number(n) <= 255);
}

function clean(raw: unknown): Door | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = typeof r.key === 'string' ? r.key : '';
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 40) : '';
  if (!KEY_RE.test(key) || !name) return null;
  if (key === MAIN_GATE) return { key, name };
  const controller = Number(r.controller), door = Number(r.door);
  if (!Number.isInteger(controller) || controller <= 0) return null;
  if (!Number.isInteger(door) || door < 1 || door > 4) return null;
  if (!validAddress(r.address)) return null;
  return { key, name, controller, address: r.address as string, door };
}

/** The doors on file, cleaned: bad entries dropped, the front gate first. */
export function doorsFor(raw: unknown): Door[] {
  const seen = new Set<string>();
  const doors: Door[] = [];
  for (const d of Array.isArray(raw) ? raw : []) {
    const c = clean(d);
    if (!c || seen.has(c.key)) continue;
    seen.add(c.key);
    doors.push(c);
  }
  const main = doors.find(d => d.key === MAIN_GATE) ?? FRONT_GATE;
  return [main, ...doors.filter(d => d.key !== MAIN_GATE)];
}

/** Can this bridge open doors other than the front gate? 1.2 and later. */
export function doorsReady(version: string | null | undefined): boolean {
  const m = String(version ?? '').match(/^(\d+)\.(\d+)/);
  if (!m) return false;
  const [maj, min] = [Number(m[1]), Number(m[2])];
  return maj > 1 || (maj === 1 && min >= 2);
}

/** The doors a tap can open right now, given the bridge at the club. */
export function openableDoors(raw: unknown, bridgeVersion: string | null | undefined): Door[] {
  const all = doorsFor(raw);
  return doorsReady(bridgeVersion) ? all : all.filter(d => d.key === MAIN_GATE);
}

/** The door with this key; no key means the front gate. Null if it isn't on file. */
export function findDoor(raw: unknown, key: unknown): Door | null {
  const k = key === undefined || key === null || key === '' ? MAIN_GATE : String(key);
  return doorsFor(raw).find(d => d.key === k) ?? null;
}

/** What the bridge needs: the front gate by key alone, another door with its controller. */
export function commandDoor(d: Door | null): Door | null {
  if (!d) return null;
  if (d.key === MAIN_GATE) return { key: d.key, name: d.name };
  return { key: d.key, name: d.name, controller: d.controller, address: d.address, door: d.door };
}

/** The name for an unlock in the log. */
export function doorName(raw: unknown, key: string | null | undefined): string {
  return (findDoor(raw, key) ?? { name: String(key) }).name;
}

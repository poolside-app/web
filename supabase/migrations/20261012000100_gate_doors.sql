-- PLAN.md AK: the board opens every wired door; members open the front gate.
--
-- gate_panels.doors lists the doors Poolside can open, each with its
-- controller (serial and LAN address) and door number. Empty means the
-- front gate only, as before. The rules are in _shared/gate_doors.ts.
-- gate_unlocks.door_key records which door an unlock was for (null: the
-- front gate, as every unlock before this was).

alter table public.gate_panels
  add column if not exists doors jsonb not null default '[]'::jsonb;

alter table public.gate_unlocks
  add column if not exists door_key text;

alter table public.gate_unlocks
  drop constraint if exists gate_unlocks_door_key_check;
alter table public.gate_unlocks
  add constraint gate_unlocks_door_key_check check (door_key is null or door_key ~ '^[a-z0-9_]{1,32}$');

-- Bishop Estates (Doug, 10/12). The snack shack controller has the Main
-- Gate and the Snack door; the pump room controller has the Pump Room and
-- the Swim Shack. Its two restroom doors (3 and 4) aren't wired to a lock
-- yet, so they're left off. Hardware notes: docs/keyfob-panels.md.
update public.gate_panels gp
   set doors = '[
     {"key": "main_gate",  "name": "Main Gate",  "controller": 423141044, "address": "10.1.10.153", "door": 1},
     {"key": "snack",      "name": "Snack",      "controller": 423141044, "address": "10.1.10.153", "door": 2},
     {"key": "pump_room",  "name": "Pump Room",  "controller": 423150481, "address": "10.1.10.173", "door": 1},
     {"key": "swim_shack", "name": "Swim Shack", "controller": 423150481, "address": "10.1.10.173", "door": 2}
   ]'::jsonb
  from public.tenants t
 where t.id = gp.tenant_id
   and t.slug = 'bishopestates'
   and gp.doors = '[]'::jsonb;

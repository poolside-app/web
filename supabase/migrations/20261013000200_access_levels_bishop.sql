-- PLAN.md AR: Bishop's doors and levels (applied after the functions that
-- understand keyfob-only doors are live, so the restrooms never get an
-- Unlock button). Tables: 20261013000100_access_levels.sql.

-- Bishop Estates (read from its old keyfob program, 10/13). The restrooms
-- are on the pump room controller (doors 3 and 4) and keyfobs open them,
-- but no remote lock is wired, so they're keyfob only. Members: Main Gate
-- and the restrooms, every day 6:00 AM-8:30 PM, until Oct 31 (94 fobs);
-- Board: every door, any time (42 fobs). Party hosts get the Snack Shack.
update public.gate_panels gp
   set doors = gp.doors || '[
     {"key": "mens",   "name": "Mens",   "controller": 423150481, "address": "10.1.10.173", "door": 3, "remote": false},
     {"key": "womens", "name": "Womens", "controller": 423150481, "address": "10.1.10.173", "door": 4, "remote": false}
   ]'::jsonb
  from public.tenants t
 where t.id = gp.tenant_id
   and t.slug = 'bishopestates'
   and not (gp.doors @> '[{"key": "mens"}]'::jsonb);

update public.settings s
   set value = jsonb_set(coalesce(s.value, '{}'::jsonb), '{access}', '{
     "levels": [
       {"key": "member", "name": "Member", "doors": ["main_gate", "mens", "womens"], "days": [0,1,2,3,4,5,6], "start": "06:00", "end": "20:30", "until": "2026-10-31"},
       {"key": "board",  "name": "Board",  "doors": ["main_gate", "snack", "pump_room", "swim_shack", "mens", "womens"], "days": [0,1,2,3,4,5,6], "start": null, "end": null, "until": null}
     ],
     "party_doors": ["snack"]
   }'::jsonb, true)
  from public.tenants t
 where t.id = s.tenant_id
   and t.slug = 'bishopestates'
   and not (coalesce(s.value, '{}'::jsonb) ? 'access');

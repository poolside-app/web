-- PLAN.md BS3 (Doug 11/4: "family needs 2 or more"): a membership level can
-- say the fewest people it covers (membership_tiers[].min_people, Money setup
-- → Membership prices). Bishop's Family is for 2 or more; one person picks
-- Single.
update public.settings s
set value = jsonb_set(s.value, '{membership_tiers}', (
  select jsonb_agg(case when t->>'slug' = 'family' and not (t ? 'min_people') then t || '{"min_people": 2}'::jsonb else t end order by ord)
  from jsonb_array_elements(s.value->'membership_tiers') with ordinality as x(t, ord)))
where s.tenant_id = '5a248774-8368-4499-984d-aecb70e4cd11'
  and jsonb_typeof(s.value->'membership_tiers') = 'array';

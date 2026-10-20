-- PLAN.md BG4 (10/20 audit): a membership level can say how many people it
-- covers (membership_tiers[].max_people, Money setup → Membership prices).
-- Bishop's Single ("One adult") covers one person.
update public.settings s
set value = jsonb_set(s.value, '{membership_tiers}', (
  select jsonb_agg(case when t->>'slug' = 'single' and not (t ? 'max_people') then t || '{"max_people": 1}'::jsonb else t end order by ord)
  from jsonb_array_elements(s.value->'membership_tiers') with ordinality as x(t, ord)))
where s.tenant_id = '5a248774-8368-4499-984d-aecb70e4cd11'
  and jsonb_typeof(s.value->'membership_tiers') = 'array';

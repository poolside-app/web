-- PLAN.md BG3 (10/20 audit): the fundraiser thermometer is recorded
-- donations + fundraiser.outside_cents, the board's own outside amount
-- (_shared/fundraiser.ts). Keep what each club typed: whatever its "Raised
-- so far" was above its recorded donations becomes its outside amount.
update public.settings s
set value = jsonb_set(s.value, '{fundraiser,outside_cents}', to_jsonb(greatest(0,
  coalesce((s.value->'fundraiser'->>'raised_cents')::bigint, 0)
  - coalesce((select sum(d.amount_cents) from public.donations d where d.tenant_id = s.tenant_id and d.status = 'verified'), 0))))
where jsonb_typeof(s.value->'fundraiser') = 'object' and not (s.value->'fundraiser' ? 'outside_cents');

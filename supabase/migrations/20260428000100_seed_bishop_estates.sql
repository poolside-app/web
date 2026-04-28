-- =============================================================================
-- Seed Bishop Estates as Tenant 1 — the test/reference tenant.
-- =============================================================================
-- Bishop Estates is grandfathered as the first Poolside tenant. Their existing
-- club app at bishop-estates.vercel.app continues to run separately; this seed
-- creates their slot in the Poolside DB so we can build features against real
-- representative data while Bishop Estates' real members eventually migrate.
--
-- Idempotent: rerunnable thanks to the slug uniqueness check.
-- =============================================================================

insert into public.tenants (slug, display_name, status, plan, trial_ends_at, notes)
values (
  'bishopestates',
  'Bishop Estates Cabana Club',
  'active',                        -- not 'trial' — grandfathered free
  'enterprise',                    -- highest tier, comped
  null,                            -- no trial expiry
  'Tenant zero. Grandfathered free per Doug as the founder''s home club; real members migrate from bishop-estates.vercel.app once feature parity is reached. Gate integration (MENGQI HXC-7000) is the verified template they pioneered.'
)
on conflict (slug) do update
  set display_name = excluded.display_name,
      status       = excluded.status,
      plan         = excluded.plan,
      notes        = excluded.notes,
      updated_at   = now();

-- Seed an empty settings row for the tenant so feature flags + config land
-- in a known place when admin starts editing.
insert into public.settings (tenant_id, value)
select id, '{}'::jsonb from public.tenants where slug = 'bishopestates'
on conflict (tenant_id) do nothing;

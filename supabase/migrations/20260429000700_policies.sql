-- =============================================================================
-- policies — Per-tenant editable apply-form policies (rules, guest, etc.)
-- =============================================================================
-- Bishop Estates' admin let the board edit each policy text directly. We
-- were missing that — the apply form's 5 policies were hardcoded
-- placeholders. This restores it AND lets clubs add their own (e.g. a
-- pet policy, code of conduct).
--
-- A policy with `required_for_apply = true` shows up as a gated checkbox
-- on the apply wizard. `false` = informational only (visible from member
-- portal "Club rules" but not blocking signup).
-- =============================================================================

create table if not exists public.policies (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  slug          text not null,                -- 'rules' / 'guest' / 'party' / 'sitter' / 'waiver' / custom
  title         text not null,
  body          text not null,                -- long-form, shown in modal during apply
  required_for_apply boolean not null default true,
  sort_order    int not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (tenant_id, slug)
);

create index if not exists policies_tenant_active_idx
  on public.policies(tenant_id, active, sort_order);

alter table public.policies enable row level security;
drop policy if exists policies_service_role on public.policies;
create policy policies_service_role on public.policies for all using (true) with check (true);

-- ── Seed BE-parity defaults for every existing tenant that has no rows ────
-- (New tenants get seeded by tenant_signup going forward.)

insert into public.policies (tenant_id, slug, title, body, sort_order, required_for_apply)
select t.id, x.slug, x.title, x.body, x.sort_order, true
from public.tenants t
cross join (values
  ('rules',  'Pool Rules',         E'Replace this with your club''s rules — the things every member should know before opening the gate.\n\nExamples:\n- Pool hours: replace with yours\n- Guests must be accompanied by a member at all times\n- Children under 12 must have an adult on deck\n- No glass on the pool deck\n- No running on the deck\n- Diving only in the deep end', 1),
  ('guest',  'Guest Policy',       E'Replace this with your club''s guest policy.\n\nA typical version:\n- Each member household may bring up to N guests per day\n- Guests must sign in at the front desk\n- Guest fee is $X per visit, paid by the host member\n- Host member is responsible for their guests'' conduct', 2),
  ('party',  'Party Policy',       E'Replace this with your club''s party rental policy.\n\nA typical version:\n- Parties must be requested through the app and approved by the board\n- Maximum N additional guests beyond your household\n- Party host is responsible for cleanup\n- $X cleaning deposit, refunded after inspection\n- Music must be turned down by 9pm', 3),
  ('sitter', 'Babysitter Policy',  E'Replace this with your club''s babysitter / nanny policy.\n\nA typical version:\n- Babysitters / nannies are admitted only with written authorization from the member household\n- The sitter must be at least 16 years old\n- Add the sitter''s name to your household via the app before they arrive\n- Sitter is treated as a guest for guest-pass purposes', 4),
  ('waiver', 'Liability Waiver',   E'Replace this with your club''s liability waiver.\n\nThis is the legal language each adult applicant agrees to. Common elements:\n- Acknowledgment that swimming carries inherent risks\n- Release of the club, board, and lifeguards from liability for ordinary negligence\n- Permission for emergency medical treatment of minors in the household\n- Authorization for use of photos taken at the club in club communications\n\nHave your board review and replace this with text approved by your insurer or attorney.', 5)
) as x(slug, title, body, sort_order)
on conflict (tenant_id, slug) do nothing;

-- =============================================================================
-- Drop documents table — feature removed 2026-05-21
-- =============================================================================
-- Documents (bylaws / handbook / forms upload) was a niche feature that Doug
-- decided to drop entirely. Zero rows in the table at deletion time. The
-- admin page, edge function, role-template scope, governance.html section,
-- and member-side display were all stripped in the same commit.
-- =============================================================================

drop table if exists public.documents cascade;

-- =============================================================================
-- Seed Doug as the founding provider admin.
-- =============================================================================
-- Initial password is bcrypt-hashed below (one-way, safe to commit).
-- is_default_pw = true forces a password change on first login —
-- the change_password endpoint clears the flag.
--
-- The plaintext password is ephemeral and lives only in chat/scratch notes
-- until first login. After Doug changes it, the original plaintext is
-- meaningless (the new hash overwrites this one).
-- =============================================================================

insert into public.provider_admins (email, password_hash, display_name, is_super, is_default_pw)
values (
  'doug.frevele@gmail.com',
  '$2b$10$Mxvxt40H8tcQyXuTlebSRuFzJAzDPh3WFo4NclivQKN5T4kS.s0wK',
  'Doug Frevele',
  true,
  true
)
on conflict (email) do nothing;

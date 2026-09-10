-- Fix pass 11 (critic N-16): nothing at the database level paired
-- expiry_mode='days' with a non-null expiry_days. Force them apart (a direct
-- UPDATE, a future migration) and the N-11 "silently re-issued expiry" class
-- returns, because the unchanged-control check compares expiry_days. Pin the
-- invariant where it cannot drift: mode 'days' <=> a positive day count.
UPDATE files SET expiry_days = NULL WHERE expiry_mode <> 'days' AND expiry_days IS NOT NULL;
UPDATE files SET expiry_mode = 'custom' WHERE expiry_mode = 'days' AND expiry_days IS NULL AND expires_at IS NOT NULL;
UPDATE files SET expiry_mode = 'none' WHERE expiry_mode = 'days' AND expiry_days IS NULL AND expires_at IS NULL;
ALTER TABLE files ADD CONSTRAINT files_expiry_mode_days_pairing
  CHECK ((expiry_mode = 'days') = (expiry_days IS NOT NULL AND expiry_days > 0));

-- Fix pass 8 (docs/reviews/code-review.md, "Polish pass review — 2026-09-10", findings
-- 1 & 2): two independent, additive changes bundled into one migration because they
-- landed in the same pass, not because they're related.

-- Finding 1: migration 0006 added `files.expiry_mode NOT NULL DEFAULT 'none'` with no
-- backfill `UPDATE`. Postgres's fast-default machinery filled every PRE-EXISTING row —
-- including every file that already has a real `expires_at` (the common case: every
-- file gets a `DEFAULT_EXPIRY_DAYS` expiry unless the sender explicitly turned it off)
-- — with the literal default, `'none'`, regardless of whether that row already had an
-- expiry. The settings page then pre-selected the "no expiry" radio for a file that
-- still very much expires, and because the settings form always submits `expiryMode` on
-- every save, saving the form for ANY OTHER reason silently wiped the file's real expiry
-- (`SettingsService.resolveExpiry('none', ...)` -> `expires_at = NULL`).
--
-- Backfill the honest guess: `'custom'` for any row that already has a real expiry —
-- there is no way to recover whether it was originally created in `days` mode (a
-- `days`-mode expiry and a `custom`-mode expiry landing on the same calendar date are
-- indistinguishable once only the resulting timestamp is stored), and `'custom'` at
-- least preserves the EXACT stored date going forward (`resolveExpiry('custom', ...)` is
-- a pure pass-through of `expiresAt`, never re-derived from "now + N days"). Rows with
-- `expires_at IS NULL` are left alone — they are already honestly `'none'`.
UPDATE files SET expiry_mode = 'custom' WHERE expires_at IS NOT NULL AND expiry_mode = 'none';

-- Finding 2: per-tenant Zoho/Drive folder ids, persisted so the tenant -> folder mapping
-- survives a process restart instead of living only in each adapter's private in-memory
-- `tenantFolderCache` (`src/adapters/{zoho,google}/real.ts`) — a fresh adapter instance
-- (i.e. every restart, routine in this single-process deployable) had an empty cache and
-- no way to ask "does this tenant already have a folder", so it unconditionally created
-- another one, forking a tenant's storage across every restart forever. Nullable:
-- existing tenants have no folder yet; `FilesService.publishFile` resolves-and-persists
-- lazily, under a Postgres advisory lock, the first time a tenant's file actually needs
-- to upload — the same "create it under a lock the first time it's needed, persist the
-- id" shape `SharingEngine`/`drive_copies` already use for intent_seq 0 (architecture.md
-- §5), just applied to a tenant-scoped resource instead of a file-scoped one.
ALTER TABLE tenants ADD COLUMN zoho_folder_id text;
ALTER TABLE tenants ADD COLUMN drive_folder_id text;

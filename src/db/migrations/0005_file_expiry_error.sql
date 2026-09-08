-- Fix pass 5, F-C (docs/reviews/critic-report.md): expiry cannot strand silently.
--
-- With BRANDED_PAGE_ENABLED=false (the shipping default), the raw Zoho public link IS the
-- distribution link — FileStorePort.revokeLink is the ONLY thing that enforces AC-U4 on
-- that path, and it is `@unverified-live` against a guessed endpoint shape. If it fails
-- permanently, the old code recorded nothing anywhere: no `file.expire` dead-letter hook
-- existed, so a dead-lettered job vanished into the `jobs` table with no operator-visible
-- trace, while the file stayed `ready` and its raw link stayed live past its advertised
-- expiry indefinitely.
--
-- `files.expiry_error` records the last dead-lettered `file.expire` failure (NULL = no
-- known stranding) — set by the new `file.expire` dead-letter hook
-- (src/jobs/queue.ts runDeadLetterHook), cleared the next time `handleFileExpire`
-- (src/jobs/handlers/file-expire.ts) actually completes the revoke successfully. Surfaced
-- as a `/readyz` count (`strandedExpiries`) and a warning badge on the file page.

ALTER TABLE files ADD COLUMN expiry_error text;

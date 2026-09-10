-- Fix pass 9 (docs/reviews/critic-report.md, R-2): the resend action had no in-flight
-- guard — the original `failed`/`unconfirmed` row never changes outcome, so the "שלח
-- שוב" button stayed live while a resend it already created was still queued, and a
-- double-click (or N rapid clicks, or N concurrent requests) sent N copies. This makes
-- the guard race-safe by construction rather than a read-then-insert TOCTOU:
-- `deliveries.insertQueuedIfNotInFlight` (src/db/repositories/deliveries.ts) relies on
-- `INSERT ... ON CONFLICT (...) DO NOTHING RETURNING *` against this exact partial
-- index, so the DATABASE — not application logic racing itself across concurrent
-- connections — decides which one concurrent resend attempt wins; every loser gets back
-- no row and the service maps that to 409, never a second mail.
--
-- Scoped to resend-originated rows only (`reason LIKE 'resend_of:%'`): the ordinary
-- inbound pipeline (`RequestPipeline.handleWebhook`, gate 10, `deliveries.insertQueued`)
-- already creates a fresh `queued` row per genuine inbound request with NO such guard,
-- and that is deliberately unchanged here — a second genuine email from the same
-- requester arriving while an earlier one is still in flight is not the same bug as a
-- UI double-click on a stale button, and that path's own dedupe is the `signature_token`
-- unique index on `inbound_messages` (gate 2), not this index. Scoping by `reason`
-- rather than, say, a boolean column keeps this additive: no backfill, no new column,
-- no risk to any row `insertQueued` has ever written.
CREATE UNIQUE INDEX deliveries_resend_in_flight_idx
  ON deliveries (file_id, requester_address)
  WHERE reason LIKE 'resend_of:%'
    AND outcome IN ('queued', 'sending', 'dispatching', 'granted');

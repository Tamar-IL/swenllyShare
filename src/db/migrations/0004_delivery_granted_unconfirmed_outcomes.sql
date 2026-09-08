-- Fix pass 5, F-A (docs/reviews/critic-report.md): `delivery.fulfill`'s crash-recovery
-- treated a row found `dispatching` on retry as "the provider probably has it, finalize
-- `sent` without ever calling the outbound port again" — correct for a genuinely lost ack,
-- WRONG for the common case of a definite non-send (Mailgun 5xx/429/4xx, a Drive
-- QuotaClassError/NotFoundError) or a truly ambiguous one (no response at all). Two schema
-- changes fix this:
--
--   'unconfirmed' — a new TERMINAL outcome for the one case that is genuinely unresolvable
--   (an `AmbiguousSendError` from the outbound call, or a bare process crash that leaves a
--   `dispatching` row with no recorded definite error on the next attempt). Replaces the
--   old dishonest behaviour of finalizing these as `sent` with `reason: 'ack_lost'` — the
--   requester may never have received the file, and the audit log must say so, not claim
--   success (src/jobs/handlers/delivery-fulfill.ts).
--
--   'granted' — a new NON-terminal outcome for the Drive-share path only: the permission
--   grant (`SharingEngine.share`) succeeded but the follow-up reply email has not been
--   confirmed sent yet. Splits what used to be one `dispatching` span covering BOTH
--   external calls into two independently retryable steps, so a reply failure after a
--   successful grant retries only the reply — never re-shares (src/db/repositories/
--   delivery-fulfillment.ts, src/jobs/handlers/delivery-fulfill.ts).

ALTER TABLE deliveries DROP CONSTRAINT deliveries_outcome_check;
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_outcome_check
  CHECK (outcome IN (
    'queued', 'sending', 'dispatching', 'granted', 'sent', 'unconfirmed', 'failed',
    'quarantined', 'rate_limited', 'expired', 'not_allowlisted'
  ));

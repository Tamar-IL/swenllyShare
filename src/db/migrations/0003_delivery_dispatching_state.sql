-- 0003_delivery_dispatching_state.sql
-- Code review finding 2 (docs/reviews/code-review.md): `delivery.fulfill`'s crash-recovery
-- treated ANY row found `sending` on retry as "the provider probably got it, finalize
-- without resending" — but `sending` was set before local work (blob open/read,
-- SharingEngine's reserve phase) that can itself throw with NO external call ever having
-- been attempted, so a retry could finalize `sent` in the audit log while the requester
-- never actually received the file.
--
-- Splits the single `sending` marker into two: `sending` (queued -> sending, before any
-- local work) and `dispatching` (sending -> dispatching, set immediately before the
-- actual outbound call — `outboundMail.send` for an attachment, `SharingEngine.share`
-- for a Drive share). A retry that finds `sending` now safely re-attempts the whole
-- delivery from scratch (nothing was ever disclosed); only `dispatching` is finalized
-- `sent` without resending (src/jobs/handlers/delivery-fulfill.ts,
-- src/db/repositories/delivery-fulfillment.ts).

ALTER TABLE deliveries DROP CONSTRAINT deliveries_outcome_check;
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_outcome_check
  CHECK (outcome IN (
    'queued', 'sending', 'dispatching', 'sent', 'failed', 'quarantined', 'rate_limited',
    'expired', 'not_allowlisted'
  ));

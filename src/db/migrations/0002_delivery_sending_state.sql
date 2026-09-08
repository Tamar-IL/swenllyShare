-- 0002_delivery_sending_state.sql
-- Red-team fixes (docs/security/red-team-report.md) that need a schema change.
--
-- F-6: `delivery.fulfill` must mark a delivery `sending` immediately before the external
-- send call, so a crash/timeout between the provider accepting the message and this
-- process recording that fact is detectable on retry (src/jobs/handlers/delivery-fulfill.ts,
-- src/db/repositories/delivery-fulfillment.ts) instead of silently re-sending the file.

ALTER TABLE deliveries DROP CONSTRAINT deliveries_outcome_check;
ALTER TABLE deliveries
  ADD CONSTRAINT deliveries_outcome_check
  CHECK (outcome IN (
    'queued', 'sending', 'sent', 'failed', 'quarantined', 'rate_limited', 'expired',
    'not_allowlisted'
  ));

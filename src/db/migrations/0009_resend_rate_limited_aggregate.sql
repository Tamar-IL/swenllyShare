-- Fix pass 10 (critic N-12): a refused resend used to write one unbounded
-- `rate_limited` row per click. Aggregate them the same way F-7 aggregates
-- suppressed quarantines: one row per (file, requester, calendar hour) with a
-- running `suppressed_count`. The partial unique index is what makes the
-- INSERT ... ON CONFLICT upsert atomic under concurrent clicks.
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_resend_rate_limited_hour_idx
  ON deliveries (file_id, requester_address, date_trunc('hour', created_at AT TIME ZONE 'UTC'))
  WHERE reason = 'resend_rate_limited' AND outcome = 'rate_limited';

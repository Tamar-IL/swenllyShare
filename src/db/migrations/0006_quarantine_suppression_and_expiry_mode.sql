-- Fix pass 7 (docs/reviews/critic-report.md, Minor findings deferred from fix passes
-- 5/6): three independent, additive schema changes bundled into one migration because
-- they landed in the same pass, not because they're related.
--
-- 1. F-7's quarantine cap (`request-pipeline.ts`, `QUARANTINE_PER_TOKEN_PER_HOUR`) used
--    to stop writing ANY audit row once a token's per-hour cap was exceeded — correct as
--    DoS protection (the write itself must be bounded, not just delivery), but it let an
--    attacker flooding a token cap the sender's own visibility into the flood on their
--    own file. `suppressed_count` backs one aggregate row per (file, calendar hour) —
--    outcome `quarantined`, reason `suppressed` — that increments instead of nothing
--    being written at all. NULL for every ordinary delivery row.
ALTER TABLE deliveries ADD COLUMN suppressed_count integer;

-- One aggregate row per file per calendar hour: the partial unique index lets
-- `deliveries.incrementSuppressed` (src/db/repositories/deliveries.ts) `INSERT ...
-- ON CONFLICT ... DO UPDATE SET suppressed_count = suppressed_count + 1` atomically,
-- with no read-then-write race between concurrent quarantine calls. `date_trunc('hour',
-- timestamptz)` alone is STABLE, not IMMUTABLE (it depends on the session's timezone
-- setting), which Postgres refuses in an index expression — `AT TIME ZONE 'UTC'` first
-- converts to a plain `timestamp` against a literal, fixed offset, which IS immutable,
-- so the truncation after it is too. The repository query's `ON CONFLICT` target must
-- use this exact expression to match the index.
CREATE UNIQUE INDEX deliveries_suppressed_hour_idx
  ON deliveries (file_id, date_trunc('hour', created_at AT TIME ZONE 'UTC'))
  WHERE reason = 'suppressed' AND outcome = 'quarantined';

-- 2. Gate 6's From-address-sanity failure (and the two quarantine gates that can also
--    fire before a From address is known) used to fall back to `msg.recipientRaw` — the
--    FILE'S OWN inbound address, not anything about the requester — as
--    `deliveries.requester_address` whenever the `From` header couldn't be resolved to
--    exactly one address. Harmless (it's the tenant's own token, already known to them)
--    but wrong data in the sender-facing "who received this" column. `requester_address`
--    becomes nullable so the pipeline can record the honest "we don't know" instead;
--    `null` renders as "לא ניתן לזהות שולח" (`src/lib/presentation.ts`).
ALTER TABLE deliveries ALTER COLUMN requester_address DROP NOT NULL;

-- 3. Expiry mode fidelity (critic-report.md Minor: "an existing expiry always renders as
--    custom date, never as the 30-day radio", `http/routes/files.ts` read model). The
--    per-file settings form needs to re-render the MODE the sender actually picked
--    (none/days/custom) and, for `days`, the day count — neither is recoverable from
--    `expires_at` alone (a `days`-mode expiry and a `custom`-mode expiry landing on the
--    same calendar date are indistinguishable once only the resulting timestamp is
--    stored). `expiry_mode`/`expiry_days` persist the form's own choice, independent of
--    the derived `expires_at` timestamp `Settings.resolveExpiry` computes from it.
ALTER TABLE files ADD COLUMN expiry_mode text NOT NULL DEFAULT 'none'
                              CHECK (expiry_mode IN ('none', 'days', 'custom'));
ALTER TABLE files ADD COLUMN expiry_days integer;

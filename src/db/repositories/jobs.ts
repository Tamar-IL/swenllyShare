import type { Queryable } from '../pool.js';

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed' | 'dead';

export interface JobRow {
  id: string;
  kind: string;
  payload: unknown;
  dedupe_key: string | null;
  run_after: Date;
  attempts: number;
  status: JobStatus;
  last_error: string | null;
  locked_at: Date | null;
  created_at: Date;
}

export type EnqueueResult = { deduped: true } | { deduped: false; row: JobRow };

export const jobs = {
  /**
   * Enqueues a job. When `dedupeKey` is given and a pending/processing/done job with
   * that key already exists, this is a no-op (`{deduped: true}`) — the unique partial
   * index on `dedupe_key` (architecture.md §3) is the actual guard; this just reads
   * whether the insert landed.
   */
  async enqueue(
    db: Queryable,
    params: {
      kind: string;
      payload?: unknown;
      dedupeKey?: string | null;
      runAfter?: Date;
    },
  ): Promise<EnqueueResult> {
    const { rows } = await db.query<JobRow>(
      `INSERT INTO jobs (kind, payload, dedupe_key, run_after)
       VALUES ($1, $2, $3, COALESCE($4, now()))
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING *`,
      [
        params.kind,
        JSON.stringify(params.payload ?? {}),
        params.dedupeKey ?? null,
        params.runAfter ?? null,
      ],
    );
    const row = rows[0];
    if (!row) return { deduped: true };
    return { deduped: false, row };
  },

  /**
   * The worker loop's claim (architecture.md §2, §11): atomically picks the
   * earliest-due pending job of one of `kinds` and marks it `processing` in a single
   * statement — `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` is
   * one round trip, so two concurrent callers against the same pool can never both
   * select the same row: the loser's subquery simply skips the row the winner has
   * locked and finds the next one (or none).
   */
  /**
   * `now` decides which pending jobs count as "due" (`run_after <= now`) and defaults to
   * the real wall clock. F-5 (`docs/security/red-team-report.md`): callers that schedule
   * a job's `run_after` from an INJECTED `Clock` (e.g. `files.scheduleExpire` from
   * `expires_at`) need `claimNext` compared against that SAME clock — a test (or a paced
   * `SharingEngine` retry) that advances only the fake clock, not Postgres's real
   * wall-clock time, must still be able to make that job claimable. `processNextJob`
   * always passes `container.ports.clock.now()`; call sites with no `Container` in scope
   * (the bare `jobs.ts` unit tests) get the real-time default, matching the original
   * `now()`-in-SQL behavior exactly.
   */
  async claimNext(
    db: Queryable,
    kinds: string[],
    now: Date = new Date(),
  ): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET status = 'processing', locked_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= $2 AND kind = ANY($1)
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [kinds, now],
    );
    return rows[0];
  },

  /**
   * Defers a job to `runAfter` without counting it as a failed attempt (`attempts`,
   * `last_error` untouched). Used for SharingEngine's paced re-share (architecture.md
   * §5): a deferred share is not a failure, so it must not erode the job's
   * `JOB_MAX_ATTEMPTS` budget the way `fail()` does.
   */
  async reschedule(db: Queryable, id: string, runAfter: Date): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET status = 'pending', run_after = $2, locked_at = NULL
       WHERE id = $1
       RETURNING *`,
      [id, runAfter],
    );
    return rows[0];
  },

  async complete(db: Queryable, id: string): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET status = 'done', locked_at = NULL WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0];
  },

  /**
   * Records a failed attempt with exponential backoff. Dead-letters
   * (`status = 'dead'`) once `attempts` (after this failure) reaches `maxAttempts` —
   * otherwise reschedules `backoffMs` from now and returns the job to `pending` for a
   * future `claimNext` to pick up.
   */
  async fail(
    db: Queryable,
    id: string,
    params: { error: string; backoffMs: number; maxAttempts: number },
  ): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs
       SET attempts = attempts + 1,
           last_error = $2,
           locked_at = NULL,
           status = CASE WHEN attempts + 1 >= $4 THEN 'dead' ELSE 'pending' END,
           run_after = now() + ($3 || ' milliseconds')::interval
       WHERE id = $1
       RETURNING *`,
      [id, params.error, params.backoffMs, params.maxAttempts],
    );
    return rows[0];
  },

  /**
   * F-5's periodic-sweep upsert (RT-53/RT-54): like `enqueue`, but a `dedupe_key` that
   * already names a `done` job gets reactivated (`status` reset to `pending`) instead of
   * silently no-op'd. Plain `enqueue`'s `ON CONFLICT ... DO NOTHING` is right for
   * one-shot work (a webhook's `delivery.fulfill`, replaying it would re-send the file) —
   * but a periodic sweep dedupe-keyed by TIME WINDOW is deliberately meant to run again
   * for the same window if new work shows up after its first (empty, no-op) run within
   * that window, which `DO NOTHING` would permanently block for the rest of the window.
   * Never touches a `pending`/`processing` row — only a `done` one is reactivated, so this
   * never disturbs a claim already in flight.
   */
  async ensureScheduled(
    db: Queryable,
    params: { kind: string; payload?: unknown; dedupeKey: string; runAfter?: Date },
  ): Promise<void> {
    await db.query(
      `INSERT INTO jobs (kind, payload, dedupe_key, run_after)
       VALUES ($1, $2, $3, COALESCE($4, now()))
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET status = 'pending', locked_at = NULL
       WHERE jobs.status = 'done'`,
      [
        params.kind,
        JSON.stringify(params.payload ?? {}),
        params.dedupeKey,
        params.runAfter ?? null,
      ],
    );
  },

  /**
   * F-5 (`docs/security/red-team-report.md`, RT-50/RT-51/RT-52): schedules `file.expire`
   * for `fileId` at `expiresAt`, or cancels the schedule when `expiresAt` is `null` — the
   * upsert `jobs.enqueue` alone can't do, since its `ON CONFLICT ... DO NOTHING` never
   * *reschedules* an existing pending job to a new `run_after` when a sender changes a
   * file's expiry after first setting it. Always keyed `expire:<fileId>` (one scheduled
   * job per file, matching the report's exact wording) and always reset to `pending` on a
   * change, even if a previous run already completed it — a sender who re-extends an
   * already-expired file's expiry needs a fresh job, not a permanently spent dedupe slot.
   */
  async scheduleExpire(
    db: Queryable,
    tenantId: string,
    fileId: string,
    expiresAt: Date | null,
  ): Promise<void> {
    const dedupeKey = `expire:${fileId}`;
    if (expiresAt === null) {
      await jobs.cancelByDedupeKey(db, dedupeKey);
      return;
    }
    await db.query(
      `INSERT INTO jobs (kind, payload, dedupe_key, run_after)
       VALUES ('file.expire', $2, $1, $3)
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET run_after = EXCLUDED.run_after, status = 'pending', attempts = 0,
                      locked_at = NULL, last_error = NULL`,
      [dedupeKey, JSON.stringify({ tenantId, fileId }), expiresAt],
    );
  },

  /**
   * Cancels any still-actionable (`pending`/`processing`) job keyed by `dedupeKey` —
   * the general-purpose form of the delete branch `scheduleExpire` already has, pulled
   * out so other lifecycle-ending writers (fix pass 4, item 1: `Files.deleteFile`) can
   * cancel a job without going through expiry-specific semantics. A `done`/`failed`/
   * `dead` job is left alone (nothing to cancel — it already stopped mattering), and a
   * currently-`processing` job is still cancelled: the in-flight attempt itself is not
   * interrupted, but this at least stops it from ever being retried after it fails, and
   * pairs with the handlers' own `status === 'deleted'` no-op guard (files.ts,
   * file-expire.ts, queue.ts) as the belt-and-braces half of the fix. Returns the number
   * of jobs actually cancelled, mainly for tests/logging.
   */
  async cancelByDedupeKey(db: Queryable, dedupeKey: string): Promise<number> {
    const { rowCount } = await db.query(
      `DELETE FROM jobs WHERE dedupe_key = $1 AND status IN ('pending', 'processing')`,
      [dedupeKey],
    );
    return rowCount ?? 0;
  },

  async findById(db: Queryable, id: string): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0];
  },

  /** Looks up a job by its (unique, when set) `dedupe_key` — used by `GET
   * /api/files/:id/status` to surface a `file.publish` job's `last_error`. */
  async findByDedupeKey(db: Queryable, dedupeKey: string): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>('SELECT * FROM jobs WHERE dedupe_key = $1', [
      dedupeKey,
    ]);
    return rows[0];
  },

  /** F-5: `/readyz`'s "have the periodic sweeps actually run recently" check — the most
   * recent `created_at` among pending/processing/done jobs of `kind` (not `done` alone:
   * a sweep that's merely scheduled and about to run within the window still counts as
   * "the scheduler is alive", which is what this check is really verifying). */
  async mostRecentScheduledAt(db: Queryable, kind: string): Promise<Date | null> {
    const { rows } = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM jobs WHERE kind = $1 ORDER BY created_at DESC LIMIT 1`,
      [kind],
    );
    return rows[0]?.created_at ?? null;
  },

  async countPending(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE status = 'pending'",
    );
    return Number(rows[0]?.count ?? '0');
  },
};

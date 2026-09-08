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
  async claimNext(db: Queryable, kinds: string[]): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>(
      `UPDATE jobs SET status = 'processing', locked_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'pending' AND run_after <= now() AND kind = ANY($1)
         ORDER BY run_after
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
      [kinds],
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

  async findById(db: Queryable, id: string): Promise<JobRow | undefined> {
    const { rows } = await db.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return rows[0];
  },

  async countPending(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM jobs WHERE status = 'pending'",
    );
    return Number(rows[0]?.count ?? '0');
  },
};

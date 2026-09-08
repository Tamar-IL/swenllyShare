import type { Queryable } from '../pool.js';

export const rateLimits = {
  /**
   * Sliding-window rate check (architecture.md §3, §4.7): increments the current
   * 1-minute bucket for `bucketKey` and returns the sum over the trailing
   * `windowMinutes` buckets, in one round trip. The CTE's insert-or-increment and the
   * sum's read of it are the same statement, so there is no window between "increment"
   * and "read the total" for a concurrent caller to land in.
   *
   * `bucketKey` should already encode which limit this is (requester/file/tenant/
   * magic-link) and its identity, e.g. `"requester:alice@example.com"`.
   */
  async incrementAndSum(db: Queryable, bucketKey: string, windowMinutes: number): Promise<number> {
    // A data-modifying CTE and the main query run against the *same* snapshot in
    // Postgres, so a plain `SELECT ... FROM rate_limit_counters` sibling to the INSERT
    // CTE would NOT see the row it just wrote. Instead: `bumped` RETURNING gives the
    // current minute's fresh, post-increment count directly, and `others` sums every
    // *other* in-window bucket (rows that already existed before this statement ran,
    // so ordinary MVCC visibility applies fine) — the two added together are the
    // correct sliding-window total in one statement, one round trip.
    const { rows } = await db.query<{ total: string }>(
      `WITH bumped AS (
         INSERT INTO rate_limit_counters (bucket_key, window_start, count)
         VALUES ($1, date_trunc('minute', now()), 1)
         ON CONFLICT (bucket_key, window_start)
         DO UPDATE SET count = rate_limit_counters.count + 1
         RETURNING count
       ),
       others AS (
         SELECT COALESCE(SUM(count), 0) AS total
         FROM rate_limit_counters
         WHERE bucket_key = $1
           AND window_start > now() - ($2 || ' minutes')::interval
           AND window_start <> date_trunc('minute', now())
       )
       SELECT (bumped.count + others.total)::text AS total
       FROM bumped, others`,
      [bucketKey, windowMinutes],
    );
    return Number(rows[0]?.total ?? '0');
  },

  /** Read-only sum, for callers that want to check without incrementing. */
  async sum(db: Queryable, bucketKey: string, windowMinutes: number): Promise<number> {
    const { rows } = await db.query<{ total: string }>(
      `SELECT COALESCE(SUM(count), 0)::text AS total
       FROM rate_limit_counters
       WHERE bucket_key = $1
         AND window_start > now() - ($2 || ' minutes')::interval`,
      [bucketKey, windowMinutes],
    );
    return Number(rows[0]?.total ?? '0');
  },

  /** Housekeeping: drop buckets older than every configured window needs. */
  async deleteOlderThan(db: Queryable, olderThanMinutes: number): Promise<number> {
    const result = await db.query(
      `DELETE FROM rate_limit_counters WHERE window_start <= now() - ($1 || ' minutes')::interval`,
      [olderThanMinutes],
    );
    return result.rowCount ?? 0;
  },
};

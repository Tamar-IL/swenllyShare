import pg from 'pg';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  connectionString: string;
  max?: number;
}

export function createPool(opts: PoolOptions): pg.Pool {
  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
  });
}

/**
 * Runs `fn` inside a single transaction on a dedicated client checked out from `pool`.
 * Commits on success, rolls back and rethrows on any error. The client is always
 * released back to the pool.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // rollback failure is secondary to the original error
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serializes `fn` against every other caller using the same `(ns, key)` pair, using
 * Postgres's session-level-in-transaction advisory lock. Must be called with a client
 * that is already inside a transaction (`BEGIN`) — the lock is released automatically
 * at COMMIT/ROLLBACK, never leaked.
 *
 * The two-argument `pg_advisory_xact_lock(int, int)` form namespaces the lock space by
 * `ns` (e.g. `'swenlly.share'`) so a `hashtext` collision on the key only causes
 * redundant serialization within that namespace, never a missed exclusion across
 * unrelated call sites (architecture.md §5).
 */
export async function withAdvisoryLock<T>(
  client: pg.PoolClient,
  ns: string,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [ns, key]);
  return fn();
}

import pg from 'pg';

const { Pool } = pg;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export interface PoolOptions {
  connectionString: string;
  max?: number;
  /** `Config.NODE_ENV` — when `'production'`, `createPool` fails fast unless TLS to
   * Postgres is demonstrably on (finding #7, docs/security/appsec-review.md). Omitted by
   * callers (tests, the standalone migration CLI) that don't gate on environment. */
  nodeEnv?: string;
  /** `Config.PG_SSL` — explicitly turns on `ssl` for the pool (and satisfies the
   * production fail-fast below) independent of what `connectionString` says, for
   * deployments where the TLS requirement isn't expressed via `sslmode=` in the URL
   * (e.g. a managed Postgres in front of a proxy that terminates TLS itself). */
  pgSsl?: boolean;
}

const TLS_REQUIRED_SSLMODES = new Set(['require', 'verify-ca', 'verify-full']);

/**
 * True when `connectionString` itself already demands a TLS connection via
 * `sslmode=require|verify-ca|verify-full` (the three `sslmode` values that refuse to
 * fall back to plaintext — `allow`/`prefer` do not qualify, since both accept a
 * plaintext connection if TLS negotiation fails).
 */
function connectionStringRequiresTls(connectionString: string): boolean {
  let sslmode: string | null;
  try {
    sslmode = new URL(connectionString).searchParams.get('sslmode');
  } catch {
    // Not a `postgres://` URL (e.g. a libpq keyword/value string) — fall back to a
    // simple param scan rather than silently treating it as TLS-less.
    const match = /(?:^|[?&\s])sslmode=([a-z-]+)/i.exec(connectionString);
    sslmode = match?.[1] ?? null;
  }
  return sslmode !== null && TLS_REQUIRED_SSLMODES.has(sslmode.toLowerCase());
}

/**
 * Builds the shared `pg.Pool` (architecture.md §9). In production, refuses to boot with a
 * Postgres connection that isn't demonstrably encrypted (finding #7,
 * docs/security/appsec-review.md): previously `ssl` was never set on the pool at all, so
 * TLS depended entirely on whatever `DATABASE_URL` happened to say, with no check that it
 * said anything. Either `DATABASE_URL` itself demands TLS (`sslmode=require`,
 * `verify-ca`, or `verify-full` — the only three modes that refuse to fall back to
 * plaintext) or `pgSsl: true` (`Config.PG_SSL`) explicitly turns `ssl` on for the pool;
 * anything else throws immediately rather than silently accepting an unencrypted (or
 * downgrade-able) connection to a datastore holding PII (architecture.md §9 item 9 in the
 * appsec review). Outside production this is a no-op either way — dev/test Postgres runs
 * on loopback with no TLS listener at all.
 */
export function createPool(opts: PoolOptions): pg.Pool {
  if (opts.nodeEnv === 'production') {
    const tlsDemanded = opts.pgSsl === true || connectionStringRequiresTls(opts.connectionString);
    if (!tlsDemanded) {
      throw new Error(
        'Refusing to boot with an unencrypted Postgres connection in production. Set ' +
          "DATABASE_URL's sslmode to require, verify-ca, or verify-full, or set PG_SSL=true.",
      );
    }
  }
  return new Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    ssl: opts.pgSsl === true ? true : undefined,
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

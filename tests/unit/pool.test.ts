import { describe, expect, it } from 'vitest';
import { createPool } from '../../src/db/pool.js';

/**
 * Finding #7 (docs/security/appsec-review.md): `createPool` must fail fast in production
 * unless TLS to Postgres is demonstrably on. No real connection is ever attempted here —
 * `pg.Pool` connects lazily, so these assertions only need the constructor (or the
 * fail-fast throw) to run, no TEST_DATABASE_URL / real Postgres required (unit, not
 * integration).
 */
describe('createPool: production TLS fail-fast', () => {
  it('throws in production when DATABASE_URL has no sslmode and PG_SSL is unset', () => {
    expect(() =>
      createPool({
        connectionString: 'postgres://user:pass@db.example.com:5432/app',
        nodeEnv: 'production',
      }),
    ).toThrow(/unencrypted Postgres/);
  });

  it('throws in production when sslmode is "prefer" or "allow" (both fall back to plaintext)', () => {
    for (const sslmode of ['prefer', 'allow']) {
      expect(() =>
        createPool({
          connectionString: `postgres://user:pass@db.example.com:5432/app?sslmode=${sslmode}`,
          nodeEnv: 'production',
        }),
      ).toThrow(/unencrypted Postgres/);
    }
  });

  it('does not throw in production when DATABASE_URL carries sslmode=require', () => {
    expect(() =>
      createPool({
        connectionString: 'postgres://user:pass@db.example.com:5432/app?sslmode=require',
        nodeEnv: 'production',
      }),
    ).not.toThrow();
  });

  it('does not throw in production for sslmode=verify-ca or verify-full either', () => {
    for (const sslmode of ['verify-ca', 'verify-full']) {
      expect(() =>
        createPool({
          connectionString: `postgres://user:pass@db.example.com:5432/app?sslmode=${sslmode}`,
          nodeEnv: 'production',
        }),
      ).not.toThrow();
    }
  });

  it('does not throw in production when PG_SSL is true, regardless of the URL', () => {
    expect(() =>
      createPool({
        connectionString: 'postgres://user:pass@db.example.com:5432/app',
        nodeEnv: 'production',
        pgSsl: true,
      }),
    ).not.toThrow();
  });

  it('does not throw outside production even with no TLS signal at all', () => {
    for (const nodeEnv of ['development', 'test', undefined]) {
      expect(() =>
        createPool({ connectionString: 'postgres://user:pass@localhost:5432/app', nodeEnv }),
      ).not.toThrow();
    }
  });

  it('sets ssl:true on the underlying pg.Pool when pgSsl is true', () => {
    const pool = createPool({
      connectionString: 'postgres://user:pass@db.example.com:5432/app',
      pgSsl: true,
    });
    // pg.Pool stores constructor options on `.options`.
    expect((pool as unknown as { options: { ssl?: unknown } }).options.ssl).toBe(true);
  });
});

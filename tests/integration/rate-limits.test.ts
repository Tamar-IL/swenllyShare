import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { rateLimits } from '../../src/db/repositories/rate-limits.js';

describe.skipIf(!hasTestDatabase())('rate_limit_counters sliding window', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('accumulates across repeated calls within the window', async () => {
    const pool = testPool();
    const key = 'requester:alice@example.com';
    expect(await rateLimits.incrementAndSum(pool, key, 60)).toBe(1);
    expect(await rateLimits.incrementAndSum(pool, key, 60)).toBe(2);
    expect(await rateLimits.incrementAndSum(pool, key, 60)).toBe(3);
  });

  it('keeps distinct bucket keys isolated', async () => {
    const pool = testPool();
    await rateLimits.incrementAndSum(pool, 'requester:a@example.com', 60);
    await rateLimits.incrementAndSum(pool, 'requester:a@example.com', 60);
    await rateLimits.incrementAndSum(pool, 'requester:b@example.com', 60);

    expect(await rateLimits.sum(pool, 'requester:a@example.com', 60)).toBe(2);
    expect(await rateLimits.sum(pool, 'requester:b@example.com', 60)).toBe(1);
  });

  it('excludes buckets older than the window', async () => {
    const pool = testPool();
    const key = 'file:some-file-id';

    // Simulate a count from 2 hours ago directly — outside any reasonable window.
    await pool.query(
      `INSERT INTO rate_limit_counters (bucket_key, window_start, count)
       VALUES ($1, date_trunc('minute', now() - interval '2 hours'), 100)`,
      [key],
    );

    // A fresh increment right now, window = 60 minutes, must not see the old bucket.
    const total = await rateLimits.incrementAndSum(pool, key, 60);
    expect(total).toBe(1);
  });

  it('concurrent increments on the same bucket all land (no lost updates)', async () => {
    const pool = testPool();
    const key = 'tenant:some-tenant-id';
    await Promise.all(Array.from({ length: 25 }, () => rateLimits.incrementAndSum(pool, key, 60)));
    expect(await rateLimits.sum(pool, key, 60)).toBe(25);
  });
});

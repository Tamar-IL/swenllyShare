import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { withAdvisoryLock, withTransaction } from '../../src/db/pool.js';

describe.skipIf(!hasTestDatabase())('pool: withTransaction / withAdvisoryLock', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('withTransaction commits on success', async () => {
    const pool = testPool();
    await withTransaction(pool, async (client) => {
      await client.query("INSERT INTO jobs (kind) VALUES ('file.publish')");
    });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM jobs WHERE kind = 'file.publish'",
    );
    expect(rows[0].count).toBe(1);
  });

  it('withTransaction rolls back on error and rethrows', async () => {
    const pool = testPool();
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("INSERT INTO jobs (kind) VALUES ('file.publish')");
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM jobs WHERE kind = 'file.publish'",
    );
    expect(rows[0].count).toBe(0);
  });

  it('withAdvisoryLock serializes two concurrent transactions on the same key', async () => {
    const pool = testPool();
    const order: string[] = [];

    async function critical(label: string, holdMs: number): Promise<void> {
      await withTransaction(pool, async (client) => {
        await withAdvisoryLock(client, 'swenlly.share', 'tenant-x:file-y', async () => {
          order.push(`${label}-start`);
          await new Promise((resolve) => setTimeout(resolve, holdMs));
          order.push(`${label}-end`);
        });
      });
    }

    await Promise.all([critical('A', 50), critical('B', 0)]);

    // Whichever ran first must fully finish (start THEN end) before the other starts —
    // interleaving (A-start, B-start, A-end, B-end) would mean the lock did not
    // exclude.
    expect(order).toHaveLength(4);
    const firstLabel = order[0]!.split('-')[0];
    expect(order[0]).toBe(`${firstLabel}-start`);
    expect(order[1]).toBe(`${firstLabel}-end`);
  });

  it('withAdvisoryLock does not serialize across different keys', async () => {
    const pool = testPool();
    const order: string[] = [];

    async function critical(key: string, label: string, holdMs: number): Promise<void> {
      await withTransaction(pool, async (client) => {
        await withAdvisoryLock(client, 'swenlly.share', key, async () => {
          order.push(`${label}-start`);
          await new Promise((resolve) => setTimeout(resolve, holdMs));
          order.push(`${label}-end`);
        });
      });
    }

    await Promise.all([critical('key-1', 'A', 50), critical('key-2', 'B', 0)]);

    // Different keys must be able to interleave: B (no delay) should finish before A's
    // delayed critical section ends.
    expect(order.indexOf('B-end')).toBeLessThan(order.indexOf('A-end'));
  });
});

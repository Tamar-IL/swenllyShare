import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { jobs } from '../../src/db/repositories/jobs.js';

describe.skipIf(!hasTestDatabase())('jobs repository', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('enqueue with a dedupe_key is a no-op on a second call with the same key', async () => {
    const pool = testPool();
    const first = await jobs.enqueue(pool, { kind: 'delivery.fulfill', dedupeKey: 'msg-1' });
    expect(first.deduped).toBe(false);

    const second = await jobs.enqueue(pool, { kind: 'delivery.fulfill', dedupeKey: 'msg-1' });
    expect(second.deduped).toBe(true);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM jobs WHERE dedupe_key = 'msg-1'",
    );
    expect(rows[0].count).toBe(1);
  });

  it('enqueue without a dedupe_key never dedupes', async () => {
    const pool = testPool();
    await jobs.enqueue(pool, { kind: 'staging.purge' });
    await jobs.enqueue(pool, { kind: 'staging.purge' });
    const { rows } = await pool.query(
      "SELECT count(*)::int AS count FROM jobs WHERE kind = 'staging.purge'",
    );
    expect(rows[0].count).toBe(2);
  });

  it('claimNext only returns pending jobs whose run_after has passed, of the requested kinds', async () => {
    const pool = testPool();
    await jobs.enqueue(pool, { kind: 'file.publish' });
    await jobs.enqueue(pool, { kind: 'file.expire' });
    await jobs.enqueue(pool, { kind: 'file.publish', runAfter: new Date(Date.now() + 60_000) });

    const claimed = await jobs.claimNext(pool, ['file.publish']);
    expect(claimed?.kind).toBe('file.publish');
    expect(claimed?.status).toBe('processing');

    // The future-dated job and the other kind must not be claimable yet.
    const claimedAgain = await jobs.claimNext(pool, ['file.publish']);
    expect(claimedAgain).toBeUndefined();
  });

  it('two concurrent claimers never receive the same job (FOR UPDATE SKIP LOCKED)', async () => {
    const pool = testPool();
    const JOB_COUNT = 30;
    await Promise.all(
      Array.from({ length: JOB_COUNT }, () => jobs.enqueue(pool, { kind: 'delivery.fulfill' })),
    );

    async function drain(): Promise<string[]> {
      const claimedIds: string[] = [];
      for (;;) {
        const job = await jobs.claimNext(pool, ['delivery.fulfill']);
        if (!job) break;
        claimedIds.push(job.id);
      }
      return claimedIds;
    }

    const [a, b] = await Promise.all([drain(), drain()]);

    const overlap = a.filter((id) => b.includes(id));
    expect(overlap).toHaveLength(0);
    expect(new Set([...a, ...b]).size).toBe(JOB_COUNT);
  });

  it('fail() backs off and reschedules to pending until maxAttempts, then dead-letters', async () => {
    const pool = testPool();
    const { row } = (await jobs.enqueue(pool, { kind: 'drive.revoke' })) as { row: { id: string } };
    const claimed = await jobs.claimNext(pool, ['drive.revoke']);
    expect(claimed?.id).toBe(row.id);

    const afterFail1 = await jobs.fail(pool, row.id, {
      error: 'boom',
      backoffMs: 1000,
      maxAttempts: 2,
    });
    expect(afterFail1?.attempts).toBe(1);
    expect(afterFail1?.status).toBe('pending');
    expect(afterFail1?.last_error).toBe('boom');

    // Re-claim (run_after was pushed into the future by backoffMs, so force it back).
    await pool.query('UPDATE jobs SET run_after = now() WHERE id = $1', [row.id]);
    await jobs.claimNext(pool, ['drive.revoke']);

    const afterFail2 = await jobs.fail(pool, row.id, {
      error: 'boom again',
      backoffMs: 1000,
      maxAttempts: 2,
    });
    expect(afterFail2?.attempts).toBe(2);
    expect(afterFail2?.status).toBe('dead');
  });

  it('complete() marks the job done', async () => {
    const pool = testPool();
    const { row } = (await jobs.enqueue(pool, { kind: 'staging.purge' })) as {
      row: { id: string };
    };
    await jobs.claimNext(pool, ['staging.purge']);
    const completed = await jobs.complete(pool, row.id);
    expect(completed?.status).toBe('done');
  });
});

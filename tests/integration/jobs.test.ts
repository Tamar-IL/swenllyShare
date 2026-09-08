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

  it('claimNext, given an explicit `now`, treats it as the definition of "due" instead of the DB\'s real clock', async () => {
    // F-5 (docs/security/red-team-report.md): `files.scheduleExpire` computes `run_after`
    // from an injected `Clock`, which in tests only ever moves via `FakeClock.advance()`
    // — never real wall-clock time. `claimNext`'s optional `now` is what lets a job
    // scheduled that way become claimable purely from virtual time passing.
    const pool = testPool();
    const future = new Date(Date.now() + 60_000);
    await jobs.enqueue(pool, { kind: 'file.expire', runAfter: future });

    expect(await jobs.claimNext(pool, ['file.expire'])).toBeUndefined();
    const claimed = await jobs.claimNext(pool, ['file.expire'], new Date(future.getTime() + 1));
    expect(claimed?.kind).toBe('file.expire');
  });

  describe('scheduleExpire (F-5, RT-50/RT-51/RT-52)', () => {
    it('schedules a file.expire job at expiresAt, and reschedules it on a later change', async () => {
      const pool = testPool();
      const fileId = '00000000-0000-0000-0000-000000000001';
      const tenantId = '00000000-0000-0000-0000-000000000002';

      const first = new Date(Date.now() + 60_000);
      await jobs.scheduleExpire(pool, tenantId, fileId, first);
      const row1 = await jobs.findByDedupeKey(pool, `expire:${fileId}`);
      expect(row1?.kind).toBe('file.expire');
      expect(row1?.status).toBe('pending');
      expect(row1?.run_after.getTime()).toBe(first.getTime());

      const second = new Date(Date.now() + 120_000);
      await jobs.scheduleExpire(pool, tenantId, fileId, second);
      const row2 = await jobs.findByDedupeKey(pool, `expire:${fileId}`);
      expect(row2?.id).toBe(row1?.id); // same dedupe-keyed row, not a second one
      expect(row2?.run_after.getTime()).toBe(second.getTime());

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = $1`,
        [`expire:${fileId}`],
      );
      expect(rows[0].n).toBe(1);
    });

    it('cancels the pending job when expiresAt is set back to null', async () => {
      const pool = testPool();
      const fileId = '00000000-0000-0000-0000-000000000003';
      const tenantId = '00000000-0000-0000-0000-000000000004';

      await jobs.scheduleExpire(pool, tenantId, fileId, new Date(Date.now() + 60_000));
      expect(await jobs.findByDedupeKey(pool, `expire:${fileId}`)).toBeDefined();

      await jobs.scheduleExpire(pool, tenantId, fileId, null);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = $1 AND status = 'pending'`,
        [`expire:${fileId}`],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('ensureScheduled (F-5, RT-53/RT-54 periodic sweeps)', () => {
    it('a done job under the same dedupe_key is reactivated to pending, not left done', async () => {
      const pool = testPool();
      await jobs.ensureScheduled(pool, { kind: 'staging.purge', dedupeKey: 'staging.purge:1' });
      const claimed = await jobs.claimNext(pool, ['staging.purge']);
      expect(claimed).toBeDefined();
      await jobs.complete(pool, claimed!.id);

      // Same window, called again — must run again, not silently no-op like plain enqueue.
      await jobs.ensureScheduled(pool, { kind: 'staging.purge', dedupeKey: 'staging.purge:1' });
      const claimedAgain = await jobs.claimNext(pool, ['staging.purge']);
      expect(claimedAgain?.id).toBe(claimed!.id);

      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM jobs WHERE dedupe_key = 'staging.purge:1'`,
      );
      expect(rows[0].n).toBe(1); // reactivated in place, never a second row
    });

    it('never disturbs a job that is still pending or processing', async () => {
      const pool = testPool();
      await jobs.ensureScheduled(pool, {
        kind: 'staging.purge',
        dedupeKey: 'staging.purge:2',
        runAfter: new Date(Date.now() + 60_000),
      });
      await jobs.ensureScheduled(pool, { kind: 'staging.purge', dedupeKey: 'staging.purge:2' });

      const row = await jobs.findByDedupeKey(pool, 'staging.purge:2');
      expect(row?.status).toBe('pending');
      expect(row?.run_after.getTime()).toBeGreaterThan(Date.now()); // untouched, not reset to now
    });
  });
});

import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';
import { driveCopies } from '../../src/db/repositories/drive-copies.js';

async function createReadyFile(container: ReturnType<typeof buildTestContainer>, tenantId: string) {
  const created = await container.services.files.createStaged({
    tenantId,
    stream: Readable.from(Buffer.from('x')),
    originalName: 'shared.bin',
    mime: 'application/octet-stream',
  });
  await runPendingJobs(container);
  return files.findById(container.pool, tenantId, created.id);
}

describe.skipIf(!hasTestDatabase())('SharingEngine (AC-E1 / AC-E2)', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('AC-E1/E2: 50 concurrent share() calls on distinct connections all succeed, with exactly ceil(50/N) copies, no copy over N permissions, and contiguous intent_seq', async () => {
    const N = 7;
    // DRIVE_SHARE_SOFT_CAP is set to exactly N: the proactive soft-cap check (serialized
    // under the advisory lock, so race-free by construction) rotates a copy the instant
    // it would exceed the fake's real per-file quota, which is also N — so the reactive
    // QuotaClassError path (also implemented and covered by the sequential test below)
    // never needs to trigger under this heavy concurrency, and the resulting copy count
    // is deterministic rather than dependent on exact interleaving.
    const container = buildTestContainer({
      DRIVE_SHARE_SOFT_CAP: N,
      SHARE_PACE_MIN_INTERVAL_MS: 0,
    });
    container.fakes.driveShare.setQuotaPerFile(N);
    const { tenantId } = await signInAsNewTenant(container, 'engine@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const REQUESTERS = 50;
    const results = await Promise.all(
      Array.from({ length: REQUESTERS }, (_, i) =>
        container.services.sharingEngine.share(tenantId, file.id, `requester-${i}@example.com`),
      ),
    );

    // (a) AC-E1: every requester ends with a working permission on some copy.
    for (const result of results) {
      expect(result.type).toBe('shared');
    }
    const shared = results.filter((r) => r.type === 'shared') as Extract<
      (typeof results)[number],
      { type: 'shared' }
    >[];
    expect(shared).toHaveLength(REQUESTERS);

    // (b) AC-E2: no overshoot — exactly ceil(50/N) copies were created.
    const copies = await driveCopies.listForFile(container.pool, tenantId, file.id);
    expect(copies).toHaveLength(Math.ceil(REQUESTERS / N));

    // (c) no copy holds more permissions than the quota.
    for (const copy of copies) {
      if (copy.drive_file_id) {
        expect(container.fakes.driveShare.permissionCount(copy.drive_file_id)).toBeLessThanOrEqual(
          N,
        );
      }
    }

    // (d) intent_seq values are contiguous starting at 0.
    const seqs = copies.map((c) => c.intent_seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: copies.length }, (_, i) => i));

    // Every requester actually has a distinct, live permission somewhere.
    const totalPermissions = copies.reduce(
      (sum, c) =>
        sum + (c.drive_file_id ? container.fakes.driveShare.permissionCount(c.drive_file_id) : 0),
      0,
    );
    expect(totalPermissions).toBe(REQUESTERS);
  });

  it('reactive QuotaClassError path: sequential shares past a small quota retire the copy and provision + retry once, transparently', async () => {
    const N = 3;
    const container = buildTestContainer({
      DRIVE_SHARE_SOFT_CAP: 1000,
      SHARE_PACE_MIN_INTERVAL_MS: 0,
    }); // proactive cap far above N
    container.fakes.driveShare.setQuotaPerFile(N);
    const { tenantId } = await signInAsNewTenant(container, 'reactive@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const copyIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const result = await container.services.sharingEngine.share(
        tenantId,
        file.id,
        `seq-${i}@example.com`,
      );
      expect(result.type).toBe('shared');
      if (result.type === 'shared') copyIds.push(result.copyId);
    }

    // First 3 shares land on the original (seq 0) copy; the 4th hits QuotaClassError and
    // is transparently retried on a freshly-provisioned seq-1 copy; the 5th reuses it.
    const uniqueCopies = new Set(copyIds);
    expect(uniqueCopies.size).toBe(2);
    expect(copyIds.slice(0, 3).every((id) => id === copyIds[0])).toBe(true);
    expect(copyIds[3]).toBe(copyIds[4]);
    expect(copyIds[3]).not.toBe(copyIds[0]);

    const copies = await driveCopies.listForFile(container.pool, tenantId, file.id);
    expect(copies).toHaveLength(2);
    const retired = copies.find((c) => c.status === 'retired');
    expect(retired?.retire_reason).toBe('quota');
  });

  it('crash-after-copy recovery: a fault injected between the Drive copy and the caller commit is recovered by findByIntent, never a duplicate Drive file', async () => {
    // Soft cap 1: seq 0 (created by file.publish) can absorb exactly one share before the
    // NEXT one crosses the cap and must provision seq 1.
    const container = buildTestContainer({
      DRIVE_SHARE_SOFT_CAP: 1,
      SHARE_PACE_MIN_INTERVAL_MS: 0,
    });
    const { tenantId } = await signInAsNewTenant(container, 'crash@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const warmup = await container.services.sharingEngine.share(
      tenantId,
      file.id,
      'warmup@example.com',
    );
    expect(warmup.type).toBe('shared');

    // The next share crosses the soft cap and must provision seq 1 — arm the crash for
    // exactly that copy() call.
    container.fakes.driveShare.crashAfterNextCopy();

    await expect(
      container.services.sharingEngine.share(tenantId, file.id, 'first@example.com'),
    ).rejects.toThrow(/injected crash/);

    // Exactly one Drive file exists for the seq-1 intent despite the crash.
    const fileCountAfterCrash = container.fakes.driveShare.fileCount;

    // Retry (simulating a process restart) — must recover via findByIntent, not create a
    // second copy for the same intent.
    const result = await container.services.sharingEngine.share(
      tenantId,
      file.id,
      'second@example.com',
    );
    expect(result.type).toBe('shared');

    expect(container.fakes.driveShare.fileCount).toBe(fileCountAfterCrash);

    const copies = await driveCopies.listForFile(container.pool, tenantId, file.id);
    const seq1Copies = copies.filter((c) => c.intent_seq === 1);
    expect(seq1Copies).toHaveLength(1);
    expect(seq1Copies[0]?.status).toBe('active');
  });

  it('paced re-share: a second share on the same copy within SHARE_PACE_MIN_INTERVAL_MS defers via job reschedule instead of calling the port again', async () => {
    // Soft cap and quota both generously high — the only thing under test is pacing on a
    // single, reused copy.
    const container = buildTestContainer({
      DRIVE_SHARE_SOFT_CAP: 1000,
      SHARE_PACE_MIN_INTERVAL_MS: 60_000,
    });
    const { tenantId } = await signInAsNewTenant(container, 'paced@example.com');
    const file = (await createReadyFile(container, tenantId))!;

    const first = await container.services.sharingEngine.share(tenantId, file.id, 'p1@example.com');
    expect(first.type).toBe('shared');
    if (first.type !== 'shared') throw new Error('unreachable');
    const permissionsAfterFirst = container.fakes.driveShare.permissionCount(first.driveFileId);

    const second = await container.services.sharingEngine.share(
      tenantId,
      file.id,
      'p2@example.com',
    );
    expect(second.type).toBe('paced');
    if (second.type === 'paced') {
      expect(second.retryAt.getTime()).toBeGreaterThan(container.ports.clock.now().getTime());
    }
    // No second external call was made — the port was never even asked for requester p2.
    expect(container.fakes.driveShare.permissionCount(first.driveFileId)).toBe(
      permissionsAfterFirst,
    );

    // Advancing past the pace interval lets the same requester succeed on the same copy.
    container.fakes.clock.advance(61_000);
    const retried = await container.services.sharingEngine.share(
      tenantId,
      file.id,
      'p2@example.com',
    );
    expect(retried.type).toBe('shared');
    if (retried.type === 'shared') {
      expect(retried.driveFileId).toBe(first.driveFileId);
    }
  });
});

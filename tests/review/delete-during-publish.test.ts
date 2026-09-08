import { Readable } from 'node:stream';
import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, testPool, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { runPendingJobs, JOB_KINDS } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * CODE REVIEW finding 1b (docs/reviews/code-review.md), now fixed and kept as a
 * regression test: deleting a file while its `file.publish` job was still in flight
 * (staging blob already removed by `Files.deleteFile`) used to make the job keep
 * failing (staged blob gone) until it dead-lettered, at which point `runDeadLetterHook`
 * unconditionally set `status='failed'` — silently resurrecting a file the sender
 * explicitly deleted, in violation of architecture.md §3 invariant 5 ("Files are never
 * hard-deleted by expiry — access is revoked; status gates every read path") and §7
 * ("Delete = immediate expiry + blob removal ... object deletion"). Fix pass 4:
 * `deleteFile` now cancels the `file.publish:<fileId>` job in the same transaction as
 * `markDeleted`; `Files.publishFile` and `runDeadLetterHook` also no-op on an
 * already-deleted file as a second line of defense (covers a job already claimed
 * `processing` an instant before that transaction commits).
 */
describe.skipIf(!hasTestDatabase())('REVIEW: delete during file.publish', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('a deleted file must not come back as status=failed', async () => {
    const container = buildTestContainer();
    const { tenantId } = await signInAsNewTenant(container, 'del-during-publish@example.com');

    // Create the staged file WITHOUT letting file.publish run yet.
    const created = await container.services.files.createStaged({
      tenantId,
      stream: Readable.from(Buffer.from('hello world')),
      originalName: 'doc.pdf',
      mime: 'application/pdf',
    });

    const staged = await files.findById(container.pool, tenantId, created.id);
    expect(staged?.status).toBe('staged');

    // Sender deletes it immediately (nothing in the route or domain layer blocks deleting
    // a still-publishing file — see src/http/routes/files.ts POST /files/:id/delete and
    // src/views/file-detail.eta, which always renders the delete action).
    const deleted = await container.services.files.deleteFile(tenantId, created.id);
    expect(deleted?.status).toBe('deleted');

    // Drive the pending file.publish job to dead-letter: each attempt fails because the
    // staged blob is gone (deleteFile already removed it), and jobs.fail() backs off into
    // the future, so force each retry due immediately, same technique as
    // tests/redteam/delivery-toctou.test.ts RT-13.
    for (let i = 0; i < container.config.JOB_MAX_ATTEMPTS + 1; i++) {
      await testPool().query(`UPDATE jobs SET run_after = now() WHERE kind = 'file.publish'`);
      await runPendingJobs(container, { kinds: JOB_KINDS });
    }

    const afterDeadLetter = await files.findById(container.pool, tenantId, created.id);
    // The bug: the dead-letter hook (src/jobs/queue.ts runDeadLetterHook) unconditionally
    // sets status='failed' for a dead file.publish job, clobbering the 'deleted' status a
    // sender already committed to.
    expect(afterDeadLetter?.status).toBe('deleted');
  });
});

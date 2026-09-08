import { Readable } from 'node:stream';
import { describe, expect, it, beforeEach } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { signInAsNewTenant } from '../setup/http.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files } from '../../src/db/repositories/files.js';

/**
 * CODE REVIEW — verifying a suspected bug: `Files.deleteFile` never cancels the
 * already-scheduled `file.expire` job (`jobs.scheduleExpire`, keyed `expire:<fileId>`,
 * set at file-creation time from `expires_at`). When that job later fires on its own
 * schedule, `handleFileExpire` (src/jobs/handlers/file-expire.ts) unconditionally sets
 * `status = 'expired'` with no check of the file's CURRENT status — clobbering a sender's
 * earlier, deliberate delete back to a live-looking 'expired' pill, in violation of
 * architecture.md §7 ("Delete = immediate expiry + blob removal ... object deletion") and
 * §3 invariant 5.
 */
describe.skipIf(!hasTestDatabase())('REVIEW: delete then a stale file.expire job', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it.fails('a deleted file must not be flipped to expired by a stale file.expire job', async () => {
    const container = buildTestContainer();
    const { tenantId } = await signInAsNewTenant(container, 'del-then-expire@example.com');

    const created = await container.services.files.createStaged({
      tenantId,
      stream: Readable.from(Buffer.from('hello world')),
      originalName: 'doc.pdf',
      mime: 'application/pdf',
    });
    // Let file.publish run so the file reaches 'ready' with its default 30-day expiry
    // (files.create already scheduled a `file.expire` job for that expires_at).
    await runPendingJobs(container);
    const ready = await files.findById(container.pool, tenantId, created.id);
    expect(ready?.status).toBe('ready');
    expect(ready?.expires_at).not.toBeNull();

    // Sender deletes the file well before its expiry.
    const deleted = await container.services.files.deleteFile(tenantId, created.id);
    expect(deleted?.status).toBe('deleted');

    // Time passes to the file's original expires_at; the file.expire job scheduled back
    // at creation time is still sitting there (deleteFile never cancelled it) and becomes
    // due.
    container.fakes.clock.advance(31 * 24 * 60 * 60 * 1000);
    await runPendingJobs(container);

    const afterExpireJob = await files.findById(container.pool, tenantId, created.id);
    // The bug: handleFileExpire unconditionally sets status='expired', overwriting
    // 'deleted'.
    expect(afterExpireJob?.status).toBe('deleted');
  });
});

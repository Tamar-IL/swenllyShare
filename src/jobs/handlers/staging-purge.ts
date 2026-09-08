import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files } from '../../db/repositories/files.js';

/** `staging.purge` (architecture.md §6): removes staged blobs above `ATTACH_LIMIT_BYTES`
 * once `STAGING_RETENTION_HOURS` has passed since the file was created — files at or
 * below the limit keep their blob for life (it's the attachment source). A system-wide
 * sweep, not per-file; re-enqueued by whatever schedules periodic jobs (`worker.ts`), not
 * by any single file's lifecycle event. */
export async function handleStagingPurge(
  container: Container,
  _payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  const candidates = await files.listStagingPurgeCandidates(container.pool, {
    attachLimitBytes: container.config.ATTACH_LIMIT_BYTES,
    olderThanHours: container.config.STAGING_RETENTION_HOURS,
  });

  for (const file of candidates) {
    if (!file.staging_blob_id) continue;
    await container.ports.blobStaging.remove(file.staging_blob_id);
    await files.clearStagingBlob(container.pool, file.tenant_id, file.id);
  }

  return { status: 'done' };
}

import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files } from '../../db/repositories/files.js';
import { driveCopies } from '../../db/repositories/drive-copies.js';
import { jobs } from '../../db/repositories/jobs.js';

/** `file.expire` (architecture.md §7): revokes the Zoho public link, enqueues a
 * `drive.revoke` per Drive copy, and marks the file `expired`. Belt-and-braces alongside
 * the request-time expiry checks — this job is what makes the "braces" (async revoke)
 * actually happen, since request-time checks alone would leave the raw links live. */
export async function handleFileExpire(
  container: Container,
  payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  const tenantId = String(payload.tenantId ?? '');
  const fileId = String(payload.fileId ?? '');
  if (!tenantId || !fileId) {
    throw new Error(`file.expire: payload missing tenantId/fileId: ${JSON.stringify(payload)}`);
  }

  const file = await files.findById(container.pool, tenantId, fileId);
  if (!file) return { status: 'done' };

  if (file.zoho_link_id) {
    await container.ports.fileStore.revokeLink(file.zoho_link_id);
  }

  const copies = await driveCopies.listForFile(container.pool, tenantId, fileId);
  for (const copy of copies) {
    if (copy.drive_file_id) {
      await jobs.enqueue(container.pool, {
        kind: 'drive.revoke',
        payload: { tenantId, fileId, copyId: copy.id },
        dedupeKey: `drive.revoke:${copy.id}`,
      });
    }
  }

  await files.setPublishStep(container.pool, tenantId, fileId, { status: 'expired' });
  return { status: 'done' };
}

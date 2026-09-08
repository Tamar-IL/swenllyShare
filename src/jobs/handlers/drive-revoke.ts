import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { driveCopies } from '../../db/repositories/drive-copies.js';

/** `drive.revoke` (architecture.md §7): revokes every permission on one Drive copy and
 * marks it `revoked`. Enqueued once per copy by `file.expire`. */
export async function handleDriveRevoke(
  container: Container,
  payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  const tenantId = String(payload.tenantId ?? '');
  const fileId = String(payload.fileId ?? '');
  const copyId = String(payload.copyId ?? '');
  if (!tenantId || !fileId || !copyId) {
    throw new Error(
      `drive.revoke: payload missing tenantId/fileId/copyId: ${JSON.stringify(payload)}`,
    );
  }

  const copy = await driveCopies.findById(container.pool, tenantId, fileId, copyId);
  if (!copy) return { status: 'done' };

  if (copy.drive_file_id) {
    await container.ports.driveShare.revokeAll(copy.drive_file_id);
  }
  await driveCopies.revoke(container.pool, tenantId, fileId, copyId);
  return { status: 'done' };
}

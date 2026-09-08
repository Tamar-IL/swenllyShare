import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';

/** `file.publish` (architecture.md §6): drives `Files.publishFile`'s crash-safe step
 * machine. A thrown error here is a genuine failure — the queue's backoff/dead-letter
 * policy (`processNextJob`) takes over from there. */
export async function handleFilePublish(
  container: Container,
  payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  const tenantId = String(payload.tenantId ?? '');
  const fileId = String(payload.fileId ?? '');
  if (!tenantId || !fileId) {
    throw new Error(`file.publish: payload missing tenantId/fileId: ${JSON.stringify(payload)}`);
  }
  await container.services.files.publishFile(tenantId, fileId);
  return { status: 'done' };
}

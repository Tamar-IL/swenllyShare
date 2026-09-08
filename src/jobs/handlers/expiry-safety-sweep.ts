import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files } from '../../db/repositories/files.js';
import { jobs } from '../../db/repositories/jobs.js';

/**
 * `expiry.safety_sweep` (F-5, `docs/security/red-team-report.md` RT-50/RT-51): the belt
 * for `file.expire`'s scheduling (`files.create`/`files.updateSettings` are the braces —
 * see their doc comments). Enqueued periodically by the worker loop
 * (`src/jobs/queue.ts`'s `ensureSweepsScheduled`), never per-file — this is the "did
 * anything fall through" check, not the primary path.
 */
export async function handleExpirySafetySweep(
  container: Container,
  _payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  const candidates = await files.listExpiredWithoutScheduledJob(container.pool);
  for (const file of candidates) {
    await jobs.enqueue(container.pool, {
      kind: 'file.expire',
      payload: { tenantId: file.tenant_id, fileId: file.id },
      dedupeKey: `expire:${file.id}`,
    });
  }
  return { status: 'done' };
}

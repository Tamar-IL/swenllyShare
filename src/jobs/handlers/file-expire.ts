import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files } from '../../db/repositories/files.js';
import { driveCopies } from '../../db/repositories/drive-copies.js';
import { jobs } from '../../db/repositories/jobs.js';

/**
 * `file.expire` (architecture.md §7): revokes the Zoho public link, enqueues a
 * `drive.revoke` per Drive copy, and marks the file `expired`. Belt-and-braces alongside
 * the request-time expiry checks — this job is what makes the "braces" (async revoke)
 * actually happen, since request-time checks alone would leave the raw links live.
 *
 * Fix pass 5, F-C (`docs/reviews/critic-report.md`): the DB status flip and the
 * `drive.revoke` enqueues are INDEPENDENT of the Zoho `revokeLink` call (an
 * `@unverified-live` call against a guessed endpoint shape) — they now happen FIRST and
 * unconditionally, so a `revokeLink` failure can no longer prevent them. Both are
 * idempotent (`setPublishStep` is a plain column write; `drive.revoke`'s dedupe key makes
 * a repeat `enqueue` a no-op), so redoing them on a retry is harmless. Only `revokeLink`
 * itself is left to throw-and-retry via the normal job backoff/dead-letter policy — and
 * because `expiry.safety_sweep` now reactivates a dead-lettered `file.expire` job
 * (`jobs.ensureScheduled`, `src/jobs/handlers/expiry-safety-sweep.ts`), a permanently
 * failing `revokeLink` keeps being retried on every sweep window instead of being
 * silently abandoned — while `runDeadLetterHook` (`src/jobs/queue.ts`) records EACH
 * dead-letter as `files.expiry_error`, so the stranding is visible (`/readyz`
 * `strandedExpiries`, a file-page badge) the whole time it persists, not invisible.
 */
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

  // Code review finding 1/4 (docs/reviews/code-review.md): a sender's `deleteFile`
  // already cancels this job's schedule (`jobs.cancelByDedupeKey`), but a job already
  // claimed `processing` an instant before that transaction commits can still reach
  // here. Belt-and-braces: never let an expiry downgrade an already-deleted file back
  // to `expired`, and skip the external revoke calls too — `deleteFile` already
  // best-effort-revoked the same Zoho link/Drive copies, so a second call here would
  // just be a wasted (and possibly erroring) retry against resources already gone.
  if (file.status === 'deleted') {
    console.log(`file.expire: file ${fileId} (tenant ${tenantId}) already deleted, no-op`);
    return { status: 'done' };
  }

  // Independent of `revokeLink` below — always run first, on every attempt including a
  // retry, so neither ever waits on the Zoho call to succeed.
  if (file.status !== 'expired') {
    await files.setPublishStep(container.pool, tenantId, fileId, { status: 'expired' });
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

  if (file.zoho_link_id) {
    // A throw here (`@unverified-live`, e.g. a 4xx/5xx from a guessed endpoint shape)
    // propagates out of this handler uncaught — `processNextJob` backs off and retries
    // it, exactly like any other job, and `runDeadLetterHook` records the stranding if
    // retries exhaust. The DB/Drive-side work above has ALREADY happened by this point,
    // regardless of what happens next.
    await container.ports.fileStore.revokeLink(file.zoho_link_id);
  }

  // Success (including a reactivated retry after a prior dead-letter) — clear any
  // previously recorded stranding marker.
  if (file.expiry_error) {
    await files.clearExpiryError(container.pool, tenantId, fileId);
  }
  return { status: 'done' };
}

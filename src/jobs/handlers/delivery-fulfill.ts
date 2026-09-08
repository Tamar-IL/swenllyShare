import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files, type FileRow } from '../../db/repositories/files.js';
import { fileAllowlist } from '../../db/repositories/file-allowlist.js';
import { deliveries } from '../../db/repositories/deliveries.js';
import {
  deliveryFulfillment,
  type DeliveryFulfillmentRow,
} from '../../db/repositories/delivery-fulfillment.js';
import { driveCopies } from '../../db/repositories/drive-copies.js';
import { ReplyComposer } from '../../domain/reply-composer.js';
import { streamToBuffer } from '../../lib/stream-to-buffer.js';
import { addressDomain } from '../../lib/email-address.js';
import {
  NotFoundError,
  PermanentError,
  QuotaClassError,
  TransientError,
} from '../../ports/errors.js';

type Mechanism = 'attachment' | 'drive_share';

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fix pass 5, F-A (`docs/reviews/critic-report.md`): a *definite* non-send — the outbound
 * call (or `SharingEngine.share`'s own Drive call) completed an exchange and the provider
 * told us, unambiguously, that nothing was delivered/granted (`TransientError`/
 * `PermanentError` from a completed HTTP response, `QuotaClassError`/`NotFoundError` from
 * Drive). Safe — and correct — to retry the whole step from scratch. Anything else
 * (`AmbiguousSendError`, or any error shape this handler doesn't recognize) is NOT
 * provably a non-send, so it is never treated as one — see the `else` branches below,
 * which finalize `unconfirmed` instead of guessing.
 */
function isDefiniteNonSend(err: unknown): boolean {
  return (
    err instanceof TransientError ||
    err instanceof PermanentError ||
    err instanceof QuotaClassError ||
    err instanceof NotFoundError
  );
}

/** Same "small enough and still staged" test the send branch below uses — pulled out so
 * the F-6 "found already `sending`"/"found already `dispatching`" branches can re-derive
 * which mechanism a stale attempt was almost certainly using without re-touching the blob
 * or the outbound port. */
async function decideMechanism(container: Container, file: FileRow): Promise<Mechanism> {
  const sizeBytes = Number(file.size_bytes);
  const blobStat = file.staging_blob_id
    ? await container.ports.blobStaging.stat(file.staging_blob_id)
    : undefined;
  return sizeBytes <= container.config.ATTACH_LIMIT_BYTES && blobStat && file.staging_blob_id
    ? 'attachment'
    : 'drive_share';
}

type GateResult = { blocked: true } | { blocked: false; file: FileRow };

/**
 * F-4 (TOCTOU, RT-10/RT-11/RT-12): gates 8-9 (allowlist, expiry/status) ran on the HTTP
 * request, potentially minutes-to-hours before this job runs. Re-reads the file fresh and
 * re-evaluates both gates against CURRENT state — on EVERY attempt, including a `sending`
 * or `granted` retry, not only the first `queued` pass — before doing anything external.
 * Shared by the main `queued`/`sending` flow and the `granted` reply-only retry so both
 * paths give the sender's emergency controls (expire now, delete now, tighten the
 * allowlist) the same last-instant veto.
 */
async function checkGatesOrTerminal(
  container: Container,
  tenantId: string,
  fileId: string,
  deliveryId: string,
  requesterAddress: string,
): Promise<GateResult> {
  const file = await files.findById(container.pool, tenantId, fileId);
  if (!file) {
    throw new Error(`delivery.fulfill: file ${fileId} not found for tenant ${tenantId}`);
  }

  const now = container.ports.clock.now();
  const isExpired = file.status !== 'ready' || (file.expires_at !== null && file.expires_at <= now);
  if (isExpired) {
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'expired',
      reason: file.status !== 'ready' ? `file_status_${file.status}` : 'expired',
    });
    return { blocked: true };
  }

  if (file.allowlist_mode === 'allowlist') {
    const domain = addressDomain(requesterAddress);
    const allowed = await fileAllowlist.matches(
      container.pool,
      tenantId,
      fileId,
      requesterAddress,
      domain,
    );
    if (!allowed) {
      await deliveries.complete(container.pool, tenantId, deliveryId, {
        outcome: 'not_allowlisted',
        reason: 'not_allowlisted',
      });
      return { blocked: true };
    }
  }

  return { blocked: false, file };
}

/**
 * The Drive-share path's reply step, shared by the first attempt (right after
 * `markGranted`) and every `granted` retry. A *definite* non-send from the reply call
 * keeps the row at `granted` (the grant already happened — never re-share) and records the
 * diagnostic for the next retry; anything ambiguous finalizes `unconfirmed` rather than
 * guessing `sent`.
 */
async function sendDriveReply(
  container: Container,
  tenantId: string,
  deliveryId: string,
  requesterAddress: string,
  file: FileRow,
  driveFileId: string,
  driveCopyId: string,
): Promise<JobHandlerResult> {
  // Drive's standard file-view URL shape — publicly documented, not an
  // `@unverified-live` API call (no adapter method returns a share URL directly, only a
  // `driveFileId`), but the exact recipient experience (visitor/OTP sharing) is one of
  // the architecture's named unverified spikes (architecture.md §12) — flagged here too.
  const shareUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
  const reply = ReplyComposer.forDriveShare(file, shareUrl);
  try {
    await container.ports.outboundMail.send({
      to: requesterAddress,
      subject: reply.subject,
      text: reply.text,
      deliveryId,
    });
  } catch (err) {
    if (isDefiniteNonSend(err)) {
      await deliveryFulfillment.recordGrantedRetryError(
        container.pool,
        tenantId,
        deliveryId,
        describeError(err),
      );
      throw err; // job-level backoff/dead-letter takes over (processNextJob)
    }
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'unconfirmed',
      mechanism: 'drive_share',
      driveCopyId,
      reason: describeError(err),
    });
    return { status: 'done' };
  }
  await deliveries.complete(container.pool, tenantId, deliveryId, {
    outcome: 'sent',
    mechanism: 'drive_share',
    driveCopyId,
  });
  return { status: 'done' };
}

/** `granted` branch: the permission grant already succeeded on a previous attempt
 * (`markGranted` recorded `drive_copy_id`) — re-checks the F-4 gates fresh, then retries
 * ONLY the reply, never re-sharing. */
async function handleGrantedRetry(
  container: Container,
  tenantId: string,
  fileId: string,
  deliveryId: string,
  requesterAddress: string,
  delivery: DeliveryFulfillmentRow,
): Promise<JobHandlerResult> {
  const gate = await checkGatesOrTerminal(
    container,
    tenantId,
    fileId,
    deliveryId,
    requesterAddress,
  );
  if (gate.blocked) return { status: 'done' };

  if (!delivery.drive_copy_id) {
    // Should be unreachable — `markGranted` always sets `drive_copy_id` in the same
    // statement that sets `outcome = 'granted'` — but never crash-loop a job forever on
    // a data shape that shouldn't happen; record it honestly instead.
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'unconfirmed',
      mechanism: 'drive_share',
      reason: 'granted_without_drive_copy_id',
    });
    return { status: 'done' };
  }

  const copy = await driveCopies.findById(container.pool, tenantId, fileId, delivery.drive_copy_id);
  if (!copy?.drive_file_id) {
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'unconfirmed',
      mechanism: 'drive_share',
      driveCopyId: delivery.drive_copy_id,
      reason: 'granted_drive_copy_missing',
    });
    return { status: 'done' };
  }

  return sendDriveReply(
    container,
    tenantId,
    deliveryId,
    requesterAddress,
    gate.file,
    copy.drive_file_id,
    copy.id,
  );
}

/**
 * `delivery.fulfill` (architecture.md §4.11, AC-R4/R5) — attaches the file when it's
 * small enough AND its staged blob still exists, otherwise auto-duplicates via
 * `SharingEngine` and sends the share link.
 *
 * **F-6 (at-most-once, RT-13) + code review finding 2 (fix pass 4) + fix pass 5 F-A:** the
 * naive version of this CAS (one `sending` marker, set once before all the local pre-send
 * work AND the external call) has a real gap — a crash reading the staged blob, or inside
 * `SharingEngine`'s local reserve transaction, throws with NO external call ever having
 * been attempted, yet a retry that merely saw `sending` would finalize `sent` anyway,
 * silently swallowing the delivery. The fix splits it into CAS steps:
 *
 *   `queued` --markSending--> `sending` --markDispatching--> `dispatching` --> `sent`
 *                                                                 (attachment path)
 *   `queued` --markSending--> `sending` --markDispatching--> `dispatching`
 *             --markGranted--> `granted` --> `sent`              (Drive-share path)
 *
 * `markSending` fires before any local work; `markDispatching` fires immediately before
 * the actual outbound call (`outboundMail.send` for an attachment, `SharingEngine.share`
 * for a Drive share).
 *
 * **Fix pass 5, F-A** (`docs/reviews/critic-report.md`): a retry finding `dispatching`
 * used to ALWAYS finalize `sent` (`reason: 'ack_lost'`) without ever calling the outbound
 * port again — correct only for a genuinely lost ack, wrong for the common case of a
 * *definite* non-send (a Mailgun 5xx/429/4xx, a Drive `QuotaClassError`/`NotFoundError`).
 * Both external calls (`outboundMail.send`, `SharingEngine.share`) are now wrapped:
 *   - a *definite* non-send (`isDefiniteNonSend`, above) reverts `dispatching` back to
 *     `sending` with the error recorded, then RETHROWS so the job-level retry/backoff/
 *     dead-letter policy (`processNextJob`) takes over — the delivery is retried, never
 *     silently marked delivered.
 *   - anything else (an `AmbiguousSendError`, or an error shape this handler doesn't
 *     recognize — including a bare process crash that leaves `dispatching` with NO
 *     recorded error at all, caught by the top-of-handler `dispatching` branch below)
 *     finalizes the delivery `unconfirmed` — an honest "we don't know" outcome, never
 *     `sent`.
 *
 * The Drive-share path additionally splits `dispatching` into two independently retryable
 * external calls instead of one span covering both: `markGranted` (below) records that the
 * permission grant succeeded BEFORE the reply email is ever attempted, so a reply failure
 * after a successful grant retries only the reply (`handleGrantedRetry`) — it never
 * re-shares (`SharingEngine.share`'s pacing/soft-cap accounting would otherwise be
 * disturbed by a redundant call, and re-granting the same permission is pointless work).
 */
export async function handleDeliveryFulfill(
  container: Container,
  payload: Record<string, unknown>,
): Promise<JobHandlerResult> {
  const tenantId = String(payload.tenantId ?? '');
  const fileId = String(payload.fileId ?? '');
  const deliveryId = String(payload.deliveryId ?? '');
  const requesterAddress = String(payload.requesterAddress ?? '');
  if (!tenantId || !fileId || !deliveryId || !requesterAddress) {
    throw new Error(
      `delivery.fulfill: payload missing required fields: ${JSON.stringify(payload)}`,
    );
  }

  const delivery = await deliveryFulfillment.getById(container.pool, tenantId, deliveryId);
  if (!delivery) {
    throw new Error(`delivery.fulfill: delivery ${deliveryId} not found for tenant ${tenantId}`);
  }

  // Already finished — a retry of an already-processed job, or a race with another
  // worker. Nothing more to do.
  if (delivery.outcome === 'sent') {
    return { status: 'done' };
  }

  // A bare process crash: `dispatching` was set, and NO definite error was ever
  // classified for this attempt (a classified definite error reverts to `sending`
  // instead, above/below — this branch only fires when nothing did). Genuinely unknown
  // whether the provider received the send. Fix pass 5, F-A: record that honestly as
  // `unconfirmed`, never `sent`.
  if (delivery.outcome === 'dispatching') {
    const file = await files.findById(container.pool, tenantId, fileId);
    const mechanism: Mechanism = file ? await decideMechanism(container, file) : 'attachment';
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'unconfirmed',
      mechanism,
      reason: 'crash_no_definite_error',
    });
    return { status: 'done' };
  }

  // The Drive permission grant already succeeded on a previous attempt; only the reply
  // email needs retrying.
  if (delivery.outcome === 'granted') {
    return handleGrantedRetry(container, tenantId, fileId, deliveryId, requesterAddress, delivery);
  }

  if (delivery.outcome !== 'queued' && delivery.outcome !== 'sending') {
    // A terminal outcome that never went through this handler's own send path
    // (quarantined/rate_limited/expired/not_allowlisted/failed/unconfirmed) — nothing to
    // send.
    return { status: 'done' };
  }

  const gate = await checkGatesOrTerminal(
    container,
    tenantId,
    fileId,
    deliveryId,
    requesterAddress,
  );
  if (gate.blocked) return { status: 'done' };
  const file = gate.file;

  if (delivery.outcome === 'queued') {
    // Step 1 of the CAS, before any local work. A lost race (another worker already
    // claimed this delivery between our read above and here) returns `undefined` —
    // nothing to do, the winner is responsible for it.
    const sending = await deliveryFulfillment.markSending(container.pool, tenantId, deliveryId);
    if (!sending) {
      return { status: 'done' };
    }
  }
  // else: outcome is already `sending` — a previous attempt of THIS SAME job crashed, or
  // hit a definite non-send, before/after the external call was ever issued. This
  // attempt owns it already; no fresh CAS is needed, just redo the work from here.

  const sizeBytes = Number(file.size_bytes);
  const blobStat = file.staging_blob_id
    ? await container.ports.blobStaging.stat(file.staging_blob_id)
    : undefined;

  if (sizeBytes <= container.config.ATTACH_LIMIT_BYTES && blobStat && file.staging_blob_id) {
    const stream = await container.ports.blobStaging.open(file.staging_blob_id);
    const content = await streamToBuffer(stream);
    const reply = ReplyComposer.forAttachment(file);
    // Step 2 of the CAS, immediately before the actual outbound call. Everything above
    // this line since `markSending` (the blob stat/open/read just done) is local work —
    // a crash there leaves the row at `sending`, safely retried from scratch above, never
    // wrongly finalized as sent.
    const dispatching = await deliveryFulfillment.markDispatching(
      container.pool,
      tenantId,
      deliveryId,
    );
    if (!dispatching) {
      return { status: 'done' };
    }
    try {
      await container.ports.outboundMail.send({
        to: requesterAddress,
        subject: reply.subject,
        text: reply.text,
        attachment: {
          filename: reply.attachmentFilename ?? file.display_name,
          content,
          contentType: file.mime,
        },
        deliveryId,
      });
    } catch (err) {
      if (isDefiniteNonSend(err)) {
        await deliveryFulfillment.revertDispatchingToSending(
          container.pool,
          tenantId,
          deliveryId,
          describeError(err),
        );
        throw err; // job-level backoff/dead-letter takes over
      }
      await deliveries.complete(container.pool, tenantId, deliveryId, {
        outcome: 'unconfirmed',
        mechanism: 'attachment',
        reason: describeError(err),
      });
      return { status: 'done' };
    }
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'sent',
      mechanism: 'attachment',
    });
    return { status: 'done' };
  }

  // Step 2 of the CAS for the Drive-share path — set before calling `share()`.
  const dispatching = await deliveryFulfillment.markDispatching(
    container.pool,
    tenantId,
    deliveryId,
  );
  if (!dispatching) {
    return { status: 'done' };
  }

  let shareResult;
  try {
    shareResult = await container.services.sharingEngine.share(tenantId, fileId, requesterAddress);
  } catch (err) {
    if (isDefiniteNonSend(err)) {
      await deliveryFulfillment.revertDispatchingToSending(
        container.pool,
        tenantId,
        deliveryId,
        describeError(err),
      );
      throw err; // job-level backoff/dead-letter takes over
    }
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'unconfirmed',
      mechanism: 'drive_share',
      reason: describeError(err),
    });
    return { status: 'done' };
  }

  if (shareResult.type === 'paced') {
    // The share itself never happened yet — no external call occurred, so it's safe
    // (and necessary) to put this delivery back to `queued` rather than leaving it
    // stuck `dispatching`.
    await deliveryFulfillment.revertDispatchingToQueued(container.pool, tenantId, deliveryId);
    return { status: 'reschedule', runAt: shareResult.retryAt };
  }

  // The grant succeeded — record it BEFORE attempting the reply, so a reply failure
  // never triggers a redundant re-share (fix pass 5, F-A).
  const granted = await deliveryFulfillment.markGranted(
    container.pool,
    tenantId,
    deliveryId,
    shareResult.copyId,
  );
  if (!granted) {
    return { status: 'done' };
  }

  return sendDriveReply(
    container,
    tenantId,
    deliveryId,
    requesterAddress,
    file,
    shareResult.driveFileId,
    shareResult.copyId,
  );
}

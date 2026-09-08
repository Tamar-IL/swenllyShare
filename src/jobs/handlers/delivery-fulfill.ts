import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files, type FileRow } from '../../db/repositories/files.js';
import { fileAllowlist } from '../../db/repositories/file-allowlist.js';
import { deliveries } from '../../db/repositories/deliveries.js';
import { deliveryFulfillment } from '../../db/repositories/delivery-fulfillment.js';
import { ReplyComposer } from '../../domain/reply-composer.js';
import { streamToBuffer } from '../../lib/stream-to-buffer.js';
import { addressDomain } from '../../lib/email-address.js';

type Mechanism = 'attachment' | 'drive_share';

/** Same "small enough and still staged" test the send branch below uses — pulled out so
 * the F-6 "found already `sending`" branch can re-derive which mechanism a stale attempt
 * was almost certainly using without re-touching the blob or the outbound port. */
async function decideMechanism(container: Container, file: FileRow): Promise<Mechanism> {
  const sizeBytes = Number(file.size_bytes);
  const blobStat = file.staging_blob_id
    ? await container.ports.blobStaging.stat(file.staging_blob_id)
    : undefined;
  return sizeBytes <= container.config.ATTACH_LIMIT_BYTES && blobStat && file.staging_blob_id
    ? 'attachment'
    : 'drive_share';
}

/**
 * `delivery.fulfill` (architecture.md §4.11, AC-R4/R5) — attaches the file when it's
 * small enough AND its staged blob still exists, otherwise auto-duplicates via
 * `SharingEngine` and sends the share link.
 *
 * **F-4 (TOCTOU, RT-10/RT-11/RT-12):** gates 8-9 (allowlist, expiry/status) ran on the
 * HTTP request, potentially minutes-to-hours before this job runs. The sender's only
 * emergency controls — expire now, delete now, tighten the allowlist — must still work
 * against a request already in flight, so this handler re-reads the file fresh and
 * re-evaluates both gates against CURRENT state before doing anything external.
 *
 * **F-6 (at-most-once, RT-13):** the `deliveries` row is moved `queued` -> `sending`
 * (a CAS, `deliveryFulfillment.markSending`) immediately before the external send call,
 * not after. A crash/timeout between the provider accepting the message and this handler
 * recording that fact leaves the row at `sending`; a retry that finds it there does NOT
 * call the outbound port again (that would be a second physical disclosure of the file —
 * exactly the harm the webhook's own replay gate exists to prevent, one layer up) and
 * instead finalizes it `sent` directly, re-deriving the mechanism rather than resending.
 * `sent` itself is treated as done on any retry — nothing here is ever sent twice.
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

  // F-6: already finished — a retry of an already-processed job, or a race with another
  // worker. Nothing more to do.
  if (delivery.outcome === 'sent') {
    return { status: 'done' };
  }

  // F-6: a previous attempt reached (or was about to reach) the external send and never
  // recorded completion. Do not resend — finalize using the mechanism this file would
  // deterministically use right now.
  if (delivery.outcome === 'sending') {
    const file = await files.findById(container.pool, tenantId, fileId);
    const mechanism: Mechanism = file ? await decideMechanism(container, file) : 'attachment';
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'sent',
      mechanism,
    });
    return { status: 'done' };
  }

  if (delivery.outcome !== 'queued') {
    // A terminal outcome that never went through this handler's own send path
    // (quarantined/rate_limited/expired/not_allowlisted/failed) — nothing to send.
    return { status: 'done' };
  }

  const file = await files.findById(container.pool, tenantId, fileId);
  if (!file) {
    throw new Error(`delivery.fulfill: file ${fileId} not found for tenant ${tenantId}`);
  }

  // F-4, re-check 1: status/expiry, evaluated fresh (a file can expire OR be deleted
  // between the webhook's gate 9 and this job running).
  const now = container.ports.clock.now();
  const isExpired = file.status !== 'ready' || (file.expires_at !== null && file.expires_at <= now);
  if (isExpired) {
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'expired',
      reason: file.status !== 'ready' ? `file_status_${file.status}` : 'expired',
    });
    return { status: 'done' };
  }

  // F-4, re-check 2: allowlist, evaluated fresh (a sender can tighten it after the
  // webhook's gate 8 already let this request through).
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
      return { status: 'done' };
    }
  }

  // F-6: the at-most-once transition. A lost race (another worker already claimed this
  // delivery between our read above and here) returns `undefined` — nothing to do, the
  // winner is responsible for it.
  const sending = await deliveryFulfillment.markSending(container.pool, tenantId, deliveryId);
  if (!sending) {
    return { status: 'done' };
  }

  const sizeBytes = Number(file.size_bytes);
  const blobStat = file.staging_blob_id
    ? await container.ports.blobStaging.stat(file.staging_blob_id)
    : undefined;

  if (sizeBytes <= container.config.ATTACH_LIMIT_BYTES && blobStat && file.staging_blob_id) {
    const stream = await container.ports.blobStaging.open(file.staging_blob_id);
    const content = await streamToBuffer(stream);
    const reply = ReplyComposer.forAttachment(file);
    await container.ports.outboundMail.send({
      to: requesterAddress,
      subject: reply.subject,
      text: reply.text,
      attachment: {
        filename: reply.attachmentFilename ?? file.display_name,
        content,
        contentType: file.mime,
      },
    });
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'sent',
      mechanism: 'attachment',
    });
    return { status: 'done' };
  }

  const shareResult = await container.services.sharingEngine.share(
    tenantId,
    fileId,
    requesterAddress,
  );
  if (shareResult.type === 'paced') {
    // The share itself never happened yet — no external send occurred, so it's safe (and
    // necessary) to put this delivery back to `queued` rather than leaving it stuck
    // `sending`, which would make the next attempt wrongly finalize it as `sent` above
    // without ever actually sharing.
    await deliveryFulfillment.revertSendingToQueued(container.pool, tenantId, deliveryId);
    return { status: 'reschedule', runAt: shareResult.retryAt };
  }

  // Drive's standard file-view URL shape — publicly documented, not an
  // `@unverified-live` API call (no adapter method returns a share URL directly, only a
  // `driveFileId`), but the exact recipient experience (visitor/OTP sharing) is one of
  // the architecture's named unverified spikes (architecture.md §12) — flagged here too.
  const shareUrl = `https://drive.google.com/file/d/${shareResult.driveFileId}/view`;
  const reply = ReplyComposer.forDriveShare(file, shareUrl);
  await container.ports.outboundMail.send({
    to: requesterAddress,
    subject: reply.subject,
    text: reply.text,
  });
  await deliveries.complete(container.pool, tenantId, deliveryId, {
    outcome: 'sent',
    mechanism: 'drive_share',
    driveCopyId: shareResult.copyId,
  });
  return { status: 'done' };
}

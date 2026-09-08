import type { Container } from '../../container.js';
import type { JobHandlerResult } from '../queue.js';
import { files } from '../../db/repositories/files.js';
import { deliveries } from '../../db/repositories/deliveries.js';
import { ReplyComposer } from '../../domain/reply-composer.js';
import { streamToBuffer } from '../../lib/stream-to-buffer.js';

/**
 * `delivery.fulfill` (architecture.md §4.11, AC-R4/R5): attaches the file when it's small
 * enough AND its staged blob still exists, otherwise auto-duplicates via `SharingEngine`
 * and sends the share link. Either way the body is the sender's `custom_message` verbatim
 * and the subject/filename use `display_name`. A `SharingEngine` pacing defer reschedules
 * this same job rather than treating it as a failure.
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

  const file = await files.findById(container.pool, tenantId, fileId);
  if (!file) {
    throw new Error(`delivery.fulfill: file ${fileId} not found for tenant ${tenantId}`);
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

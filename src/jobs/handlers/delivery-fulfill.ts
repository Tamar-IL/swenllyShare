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
 * re-evaluates both gates against CURRENT state before doing anything external, on
 * EVERY attempt (including a `sending` retry, not only the first `queued` pass).
 *
 * **F-6 (at-most-once, RT-13) + code review finding 2 (fix pass 4):** the naive version
 * of this CAS (one `sending` marker, set once before all the local pre-send work AND
 * the external call) has a real gap — a crash reading the staged blob, or inside
 * `SharingEngine`'s local reserve transaction, throws with NO external call ever having
 * been attempted, yet a retry that merely saw `sending` would finalize `sent` anyway,
 * silently swallowing the delivery. The fix splits it into two CAS steps:
 *
 *   `queued` --markSending--> `sending` --markDispatching--> `dispatching` --> `sent`
 *
 * `markSending` fires before any local work; `markDispatching` fires immediately before
 * the actual outbound call (`outboundMail.send` for an attachment, `SharingEngine.share`
 * — which itself calls `sharePermission` — for a Drive share). A retry that finds
 * `sending` therefore means the crash happened strictly BEFORE any external call was
 * attempted — safe, and necessary, to redo the whole delivery from scratch. A retry that
 * finds `dispatching` means the crash happened at-or-after the call was issued — the
 * provider may already have it, so this finalizes `sent` (`reason: 'ack_lost'`) without
 * ever calling the outbound port again, exactly RT-13's scenario.
 *
 * One accepted residual gap, worth being explicit about: for the Drive-share path,
 * `markDispatching` is set right before calling `SharingEngine.share(...)`, not at the
 * exact instant `sharePermission` fires deep inside it — `share()` first runs its own
 * fast, local, advisory-locked reserve transaction (no external I/O) before ever
 * touching the network. A crash inside that narrow, in-process window would (like the
 * `dispatching` case generally) finalize `sent` without a share having happened. Doing
 * better would mean threading a "mark dispatching" callback through `SharingEngine`
 * itself — a larger interface change than this fix pass's scope — so this is flagged
 * rather than silently accepted.
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

  // A previous attempt reached (or was about to reach) the external send and never
  // recorded completion. Do not resend — finalize using the mechanism this file would
  // deterministically use right now.
  if (delivery.outcome === 'dispatching') {
    const file = await files.findById(container.pool, tenantId, fileId);
    const mechanism: Mechanism = file ? await decideMechanism(container, file) : 'attachment';
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'sent',
      mechanism,
      reason: 'ack_lost',
    });
    return { status: 'done' };
  }

  if (delivery.outcome !== 'queued' && delivery.outcome !== 'sending') {
    // A terminal outcome that never went through this handler's own send path
    // (quarantined/rate_limited/expired/not_allowlisted/failed) — nothing to send.
    return { status: 'done' };
  }

  const file = await files.findById(container.pool, tenantId, fileId);
  if (!file) {
    throw new Error(`delivery.fulfill: file ${fileId} not found for tenant ${tenantId}`);
  }

  // F-4, re-check 1: status/expiry, evaluated fresh (a file can expire OR be deleted
  // between the last check and now) — re-run even on a `sending` retry, since time has
  // passed since that attempt crashed and the sender's emergency controls must still win.
  const now = container.ports.clock.now();
  const isExpired = file.status !== 'ready' || (file.expires_at !== null && file.expires_at <= now);
  if (isExpired) {
    await deliveries.complete(container.pool, tenantId, deliveryId, {
      outcome: 'expired',
      reason: file.status !== 'ready' ? `file_status_${file.status}` : 'expired',
    });
    return { status: 'done' };
  }

  // F-4, re-check 2: allowlist, evaluated fresh for the same reason.
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

  if (delivery.outcome === 'queued') {
    // Step 1 of the CAS, before any local work. A lost race (another worker already
    // claimed this delivery between our read above and here) returns `undefined` —
    // nothing to do, the winner is responsible for it.
    const sending = await deliveryFulfillment.markSending(container.pool, tenantId, deliveryId);
    if (!sending) {
      return { status: 'done' };
    }
  }
  // else: outcome is already `sending` — a previous attempt of THIS SAME job crashed
  // before any external call was ever issued (see the doc comment above). This attempt
  // owns it already; no fresh CAS is needed, just redo the work from here.

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

  // Step 2 of the CAS for the Drive-share path — set before calling `share()` (see the
  // doc comment above for the narrow, accepted gap this leaves inside `share()`'s own
  // local reserve phase).
  const dispatching = await deliveryFulfillment.markDispatching(
    container.pool,
    tenantId,
    deliveryId,
  );
  if (!dispatching) {
    return { status: 'done' };
  }

  const shareResult = await container.services.sharingEngine.share(
    tenantId,
    fileId,
    requesterAddress,
  );
  if (shareResult.type === 'paced') {
    // The share itself never happened yet — no external call occurred, so it's safe
    // (and necessary) to put this delivery back to `queued` rather than leaving it
    // stuck `dispatching`, which would make the next attempt wrongly finalize it as
    // `sent` above without ever actually sharing.
    await deliveryFulfillment.revertDispatchingToQueued(container.pool, tenantId, deliveryId);
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

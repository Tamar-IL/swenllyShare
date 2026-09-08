import type { Readable } from 'node:stream';
import type pg from 'pg';
import { files, type FileRow } from '../db/repositories/files.js';
import { driveCopies } from '../db/repositories/drive-copies.js';
import { jobs } from '../db/repositories/jobs.js';
import type { FileStorePort } from '../ports/file-store.js';
import type { DriveSharePort } from '../ports/drive-share.js';
import type { BlobStagingPort } from '../ports/blob-staging.js';
import type { TokenGen } from '../ports/token-gen.js';
import type { Clock } from '../ports/clock.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { limitStream, PayloadTooLargeError } from '../lib/byte-limit.js';
import type { SettingsService } from './settings.js';

const REQUEST_TOKEN_BITS = 130;
const PUBLIC_SLUG_BITS = 130;

export interface FileStatusView {
  status: FileRow['status'];
  publishStep: string;
  error?: string;
}

/**
 * File lifecycle: staged creation from an upload stream (architecture.md §6), the
 * `file.publish` step machine (crash-safe — each step is skipped once its column is set),
 * status projection, and deletion.
 */
export class FilesService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly ports: {
      fileStore: FileStorePort;
      driveShare: DriveSharePort;
      blobStaging: BlobStagingPort;
      tokenGen: TokenGen;
      clock: Clock;
    },
    private readonly config: { MAX_UPLOAD_BYTES: number; DEFAULT_EXPIRY_DAYS: number },
    private readonly settings: SettingsService,
  ) {}

  /**
   * Streams `stream` straight to staging under the hard byte cap, then creates the
   * `files` row (`status='staged'`) and enqueues `file.publish`. Never buffers the whole
   * upload in memory (architecture.md §6, §10). Throws `AppError(TOO_LARGE, 413)` if the
   * stream exceeds `maxBytes` — the partially-written staged blob is cleaned up first.
   */
  async createStaged(params: {
    tenantId: string;
    stream: Readable;
    originalName: string;
    mime: string;
    maxBytes?: number;
  }): Promise<FileRow> {
    const maxBytes = params.maxBytes ?? this.config.MAX_UPLOAD_BYTES;
    const id = this.ports.blobStaging.newId();
    const limiter = limitStream(maxBytes);
    const limited = params.stream.pipe(limiter);
    // `pipe()` starts flowing synchronously; `blobStaging.put` attaches its own listeners
    // an instant later. A defensive no-op listener here guarantees Node never treats a
    // same-tick error as "unhandled" regardless of adapter internals — `put`'s own
    // rejection (caught below) is what actually surfaces the failure.
    limited.on('error', () => {});
    let bytes: number;
    try {
      const result = await this.ports.blobStaging.put(id, limited);
      bytes = result.bytes;
    } catch (err) {
      await this.ports.blobStaging.remove(id).catch(() => {});
      if (err instanceof PayloadTooLargeError) {
        throw new AppError(ErrorCode.TOO_LARGE, 413, `file exceeds the ${maxBytes}-byte limit`);
      }
      throw err;
    }

    const requestToken = this.ports.tokenGen.opaque(REQUEST_TOKEN_BITS);
    const publicSlug = this.ports.tokenGen.opaque(PUBLIC_SLUG_BITS);
    const expiresAt = this.settings.resolveExpiry(
      'days',
      { days: this.config.DEFAULT_EXPIRY_DAYS },
      this.ports.clock,
    );

    const row = await files.create(this.pool, {
      tenantId: params.tenantId,
      displayName: params.originalName,
      originalName: params.originalName,
      sizeBytes: bytes,
      mime: params.mime,
      requestToken,
      publicSlug,
      stagingBlobId: id,
      expiresAt,
    });

    await jobs.enqueue(this.pool, {
      kind: 'file.publish',
      payload: { tenantId: params.tenantId, fileId: row.id },
      dedupeKey: `file.publish:${row.id}`,
    });

    return row;
  }

  async getStatus(tenantId: string, fileId: string): Promise<FileStatusView | undefined> {
    const file = await files.findById(this.pool, tenantId, fileId);
    if (!file) return undefined;

    let publishStep: string;
    if (file.status === 'ready') publishStep = 'ready';
    else if (file.status === 'failed') publishStep = 'failed';
    else if (file.zoho_link_id) publishStep = 'ready';
    else if (file.drive_active_copy_id) publishStep = 'creating_link';
    else if (file.zoho_resource_id) publishStep = 'uploading_drive';
    else publishStep = 'uploading_zoho';

    let error: string | undefined;
    if (file.status === 'failed') {
      const job = await jobs.findByDedupeKey(this.pool, `file.publish:${fileId}`);
      error = job?.last_error ?? 'publish_failed';
    }

    return { status: file.status, publishStep, error };
  }

  /**
   * The `file.publish` worker's step machine (architecture.md §6). Each step is skipped
   * if its result column is already set — safe to call repeatedly across job retries and
   * process crashes, no compensation needed.
   */
  async publishFile(tenantId: string, fileId: string): Promise<FileRow> {
    let file = await files.findById(this.pool, tenantId, fileId);
    if (!file) throw new AppError(ErrorCode.NOT_FOUND, 404, `file ${fileId} not found`);
    if (file.status === 'ready') return file;
    if (!file.staging_blob_id) {
      throw new Error(`file ${fileId} has no staged blob to publish from`);
    }

    if (file.status === 'staged') {
      await files.setPublishStep(this.pool, tenantId, fileId, { status: 'publishing' });
    }

    // Step 1: Zoho chunked upload.
    let zohoResourceId = file.zoho_resource_id;
    if (!zohoResourceId) {
      const stream = await this.ports.blobStaging.open(file.staging_blob_id);
      const result = await this.ports.fileStore.upload(
        tenantId,
        stream,
        Number(file.size_bytes),
        file.display_name,
      );
      zohoResourceId = result.resourceId;
      await files.setPublishStep(this.pool, tenantId, fileId, { zohoResourceId });
    }

    // Step 2: Drive resumable upload -> drive_copies intent_seq 0.
    let driveActiveCopyId = file.drive_active_copy_id;
    if (!driveActiveCopyId) {
      const intentSeq = 0;
      const intentKey = `${tenantId}:${fileId}:${intentSeq}`;
      const inserted = await driveCopies.insertIntent(this.pool, {
        tenantId,
        fileId,
        intentSeq,
        intentKey,
      });
      const copyRow =
        inserted ?? (await driveCopies.getBySeq(this.pool, tenantId, fileId, intentSeq));
      if (!copyRow)
        throw new Error(`file.publish: lost race with no row for seq 0 on file ${fileId}`);

      let driveFileId =
        copyRow.drive_file_id ?? (await this.ports.driveShare.findByIntent(intentKey))?.driveFileId;
      if (!driveFileId) {
        const stream = await this.ports.blobStaging.open(file.staging_blob_id);
        const result = await this.ports.driveShare.uploadResumable(
          stream,
          Number(file.size_bytes),
          file.display_name,
          file.mime,
        );
        driveFileId = result.driveFileId;
      }
      await driveCopies.activate(this.pool, tenantId, fileId, copyRow.id, driveFileId);
      await files.setPublishStep(this.pool, tenantId, fileId, { driveActiveCopyId: copyRow.id });
      driveActiveCopyId = copyRow.id;
    }

    // Step 3: Zoho public link.
    if (!file.zoho_link_id) {
      const link = await this.ports.fileStore.createPublicLink(zohoResourceId, {
        allowDownload: true,
      });
      await files.setPublishStep(this.pool, tenantId, fileId, {
        zohoLinkId: link.linkId,
        zohoPublicLink: link.url,
        zohoEmbedToken: link.embedToken,
      });
    }

    // Step 4: ready.
    await files.setPublishStep(this.pool, tenantId, fileId, { status: 'ready' });
    file = await files.findById(this.pool, tenantId, fileId);
    if (!file) throw new Error(`file ${fileId} disappeared during publish`);
    return file;
  }

  /** Delete = immediate revocation + blob/Drive/Zoho object cleanup (architecture.md §7).
   * External cleanup is best-effort: a failed cleanup call never blocks marking the file
   * deleted, since `status` alone gates every read path from here on. */
  async deleteFile(tenantId: string, fileId: string): Promise<FileRow | undefined> {
    const file = await files.findById(this.pool, tenantId, fileId);
    if (!file) return undefined;

    if (file.staging_blob_id) {
      await this.ports.blobStaging.remove(file.staging_blob_id).catch(() => {});
    }
    if (file.zoho_resource_id) {
      await this.ports.fileStore.delete(file.zoho_resource_id).catch(() => {});
    }
    const copies = await driveCopies.listForFile(this.pool, tenantId, fileId);
    for (const copy of copies) {
      if (copy.drive_file_id) {
        await this.ports.driveShare.delete(copy.drive_file_id).catch(() => {});
      }
    }
    return files.markDeleted(this.pool, tenantId, fileId);
  }
}

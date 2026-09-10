import type { Readable } from 'node:stream';
import { withTransaction, type Pool } from '../db/pool.js';
import { files, type FileRow, type AllowlistMode } from '../db/repositories/files.js';
import { driveCopies } from '../db/repositories/drive-copies.js';
import { jobs } from '../db/repositories/jobs.js';
import type { FileStorePort } from '../ports/file-store.js';
import type { DriveSharePort } from '../ports/drive-share.js';
import type { BlobStagingPort } from '../ports/blob-staging.js';
import type { TokenGen } from '../ports/token-gen.js';
import type { Clock } from '../ports/clock.js';
import type { Logger } from '../logger.js';
import { AppError, ErrorCode } from '../lib/errors.js';
import { limitStream, PayloadTooLargeError } from '../lib/byte-limit.js';
import type { SettingsService } from './settings.js';

const REQUEST_TOKEN_BITS = 130;
const PUBLIC_SLUG_BITS = 130;

/** `type/subtype` per RFC 2045/6838's token grammar (`token = 1*<any CHAR except CTLs
 * or tspecials>`), restricted further to the lowercase-only characters this function
 * ever produces — params are stripped before this ever runs, so `;` doesn't need to be
 * allowed here. */
const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const DEFAULT_MIME = 'application/octet-stream';

/**
 * Normalizes a client-supplied MIME type before it is ever stored (finding #4,
 * docs/security/appsec-review.md): the raw `Content-Type` a browser/client sends on
 * upload was previously written straight to the `mime` column and echoed verbatim as the
 * `Content-Type` response header on every download (`public-share.ts`) — no allowlist, so
 * a crafted value (e.g. containing a control character) could corrupt that response
 * header (a 500 on every subsequent download of the file). Lowercases, drops any
 * `;charset=...`-style parameters (and anything else after the first `;`, which also
 * strips a header-injection attempt hiding inside a "parameter"), strips control
 * characters, then validates what's left against a conservative `type/subtype` grammar —
 * anything that doesn't come out clean falls back to `application/octet-stream` rather
 * than ever writing something download-time can't safely echo.
 */
export function normalizeMime(raw: string): string {
  const beforeParams = raw.split(';', 1)[0] ?? '';
  const cleaned = beforeParams
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .toLowerCase();
  return MIME_RE.test(cleaned) ? cleaned : DEFAULT_MIME;
}

// Kept identical to `SettingsService`'s cap so a file's name never has a smaller ceiling
// than a subsequent settings save would allow.
const DISPLAY_NAME_MAX_LENGTH = 255;
const FALLBACK_DISPLAY_NAME = 'file';

/**
 * Cleans a client-supplied filename before it becomes the file's initial `display_name`
 * (finding #5/#6, docs/security/appsec-review.md — "wherever display name ... enters",
 * not only the settings-form edit path this row's remediation names): `display_name`
 * flows verbatim into an outbound email subject and attachment filename
 * (`reply-composer.ts`), so it must never carry CR/LF/control characters even when it's
 * never touched through `/files/:id/settings`. Unlike the settings-form save (which
 * rejects an over-length or empty name with a validation error the user can fix), an
 * upload has no equivalent field to correct — a pathological or empty filename here
 * silently truncates/falls back instead of failing the whole upload.
 */
function sanitizeInitialDisplayName(rawFilename: string): string {
  const cleaned = rawFilename.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim();
  const capped = cleaned.slice(0, DISPLAY_NAME_MAX_LENGTH);
  return capped === '' ? FALLBACK_DISPLAY_NAME : capped;
}

/**
 * Strips NUL bytes only, leaving `original_name` otherwise byte-for-byte raw (fix pass
 * 4, surfaced in fix pass 3): unlike `display_name`, this column is a pure audit trail
 * (never echoed into a header, subject, or filename) and is deliberately NOT run through
 * `sanitizeInitialDisplayName`'s broader control-character stripping. But Postgres's
 * `text` type physically cannot store a `\x00` byte (`invalid byte sequence for encoding
 * "UTF8": 0x00`), so a filename containing one — trivial for a client to send, since
 * `multipart` filenames are client-controlled and never validated by the browser — 500s
 * on `files.create`'s INSERT with no user-facing explanation. NUL is the one byte that
 * must go; everything else about the raw name (other control chars, path separators,
 * length) is preserved verbatim.
 */
function stripNulBytes(rawFilename: string): string {
  return rawFilename.replace(/\x00/g, '');
}

/** Re-exported so `src/http/routes/files.ts` (which may not import
 * `db/repositories/**` directly, architecture.md §2 boundary rule 1) can still name this
 * type for its settings-form body. */
export type { AllowlistMode };

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
    private readonly pool: Pool,
    private readonly ports: {
      fileStore: FileStorePort;
      driveShare: DriveSharePort;
      blobStaging: BlobStagingPort;
      tokenGen: TokenGen;
      clock: Clock;
      // Fix pass 7 (docs/reviews/critic-report.md Minor): injected via `container.ts` so
      // this domain service never reaches for `console.log` (architecture.md §10).
      logger: Logger;
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
      displayName: sanitizeInitialDisplayName(params.originalName),
      originalName: stripNulBytes(params.originalName),
      sizeBytes: bytes,
      mime: normalizeMime(params.mime),
      requestToken,
      publicSlug,
      stagingBlobId: id,
      expiresAt,
      // Fix pass 7 (critic-report.md Minor): the settings form's own choice behind
      // `expiresAt` above (migration 0006) — every new file starts life in `days` mode
      // at `DEFAULT_EXPIRY_DAYS`, matching the `resolveExpiry('days', ...)` call three
      // lines up exactly.
      expiryMode: 'days',
      expiryDays: this.config.DEFAULT_EXPIRY_DAYS,
    });

    await jobs.enqueue(this.pool, {
      kind: 'file.publish',
      payload: { tenantId: params.tenantId, fileId: row.id },
      dedupeKey: `file.publish:${row.id}`,
    });

    return row;
  }

  /**
   * Boundary rule 1 (architecture.md §2, `eslint.config.js`): HTTP handlers may not
   * query repositories directly — these three thin read wrappers (`list`, `getById`,
   * `resolveBySlug`) are what `src/http/routes/files.ts` and `public-share.ts` now call
   * instead of `files.list`/`files.findById`/`files.resolveBySlug` straight from the
   * route. No behavior change, just the call going through the domain service that owns
   * this table's lifecycle.
   */
  async list(tenantId: string, opts: { limit?: number } = {}): Promise<FileRow[]> {
    return files.list(this.pool, tenantId, opts);
  }

  async getById(tenantId: string, fileId: string): Promise<FileRow | undefined> {
    return files.findById(this.pool, tenantId, fileId);
  }

  /** Cross-tenant resolver #2 (architecture.md §3 invariant 1) — the branded page's
   * slug lookup (`GET /s/:slug`), which by definition has no tenant to scope by yet. */
  async resolveBySlug(publicSlug: string): Promise<FileRow | undefined> {
    return files.resolveBySlug(this.pool, publicSlug);
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
    // Code review finding 1/4 (docs/reviews/code-review.md): `deleteFile` cancels this
    // job in the same transaction as `markDeleted`, but a job already claimed
    // `processing` an instant before that commit can still reach here — its staged blob
    // is gone (`deleteFile` already removed it), so without this guard every step-1
    // `blobStaging.open` below would throw, eventually dead-lettering the job and (before
    // this fix) clobbering `deleted` back to `failed`. Nothing is left to publish, so
    // this is a no-op that completes the job rather than a failure that retries it.
    if (file.status === 'deleted') {
      this.ports.logger.info({ fileId, tenantId }, 'file.publish: file already deleted, no-op');
      return file;
    }
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
          tenantId,
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

    // Code review finding 1 (docs/reviews/code-review.md): a delete must be terminal —
    // cancel every still-actionable lifecycle job for this file in the SAME transaction
    // as markDeleted, so neither a stale `file.expire` (scheduled back at create/
    // updateSettings time for the file's original expiry) nor a `file.publish` still
    // in flight (dead-lettering because the staging blob it needs was just removed
    // above) can resurrect the row into `expired`/`failed` after this commits. Both
    // dedupe keys are deterministic (`files.create`/`updateSettings` and
    // `createStaged` respectively), so no extra lookup is needed. Belt-and-braces:
    // `handleFileExpire`, `handleFilePublish`, and `runDeadLetterHook` also no-op on a
    // file already `status = 'deleted'`, closing the window for any job kind this
    // cancellation missed (e.g. one already claimed `processing` by a worker the
    // instant before this transaction commits).
    return withTransaction(this.pool, async (client) => {
      await jobs.cancelByDedupeKey(client, `expire:${fileId}`);
      await jobs.cancelByDedupeKey(client, `file.publish:${fileId}`);
      return files.markDeleted(client, tenantId, fileId);
    });
  }
}

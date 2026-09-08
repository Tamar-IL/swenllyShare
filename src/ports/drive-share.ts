import type { Readable } from 'node:stream';

/**
 * Google Drive — the per-recipient auto-duplication mechanism behind `SharingEngine`
 * (architecture.md §5). One `driveFileId` is shared to many requester emails until it
 * approaches Drive's opaque, velocity-based sharing ceiling, at which point a fresh copy
 * is provisioned. `intentKey` (`"<tenant>:<file>:<seq>"`) is stashed in the copy's
 * `appProperties` so a crash between `copy` and the caller's commit is recoverable by
 * `findByIntent` instead of creating a duplicate copy.
 */
export interface DriveSharePort {
  /** Resumable upload of the original file into the tenant's folder on the Shared Drive. */
  uploadResumable(
    stream: Readable,
    sizeBytes: number,
    name: string,
    mime: string,
  ): Promise<{ driveFileId: string }>;

  /**
   * Copies `driveFileId`, stamping `appProperties.swenllyIntent = intentKey` on the copy.
   * Idempotency partner is `findByIntent` — always call that first (architecture.md §5).
   */
  copy(driveFileId: string, intentKey: string): Promise<{ driveFileId: string }>;

  /** Looks up a previously made copy by its stamped intent key, if one exists. */
  findByIntent(intentKey: string): Promise<{ driveFileId: string } | undefined>;

  /**
   * Grants `reader` access to `email` on `driveFileId`. Throws `QuotaClassError`
   * (`src/ports/errors.ts`) when Drive's sharing velocity limit is hit — this is the
   * signal `SharingEngine` reacts to, never a hard-coded count.
   */
  sharePermission(driveFileId: string, email: string): Promise<{ permissionId: string }>;

  /** Revokes every permission granted on `driveFileId` — part of `file.expire`. */
  revokeAll(driveFileId: string): Promise<void>;

  /** Deletes the Drive object — part of file deletion / a retired copy's cleanup. */
  delete(driveFileId: string): Promise<void>;
}

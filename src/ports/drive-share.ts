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
  /**
   * Resumable upload of the original file into the tenant's folder on the Shared Drive.
   * `tenantFolder` (== the caller's `tenantId`, per `FilesService.publishFile` — the
   * same convention `FileStorePort.upload`'s own `tenantFolder` param uses) names which
   * tenant's folder to create-or-reuse (fix pass 7, critic-report.md #6): before this,
   * the doc comment above already promised "into the tenant's folder" but the method
   * took no such parameter and every tenant's files landed in one shared root.
   */
  uploadResumable(
    tenantFolder: string,
    stream: Readable,
    sizeBytes: number,
    name: string,
    mime: string,
  ): Promise<{ driveFileId: string }>;

  /**
   * Resolves `tenantFolder` (== the caller's `tenantId`) to a real Drive folder id,
   * creating it if none exists yet. `uploadResumable()` already calls this internally
   * (so this suite's plain contract tests keep working unchanged) — it is exposed on the
   * port separately so `FilesService.publishFile` (fix pass 8, code-review.md
   * polish-pass finding 2) can resolve-and-persist a tenant's folder id to
   * `tenants.drive_folder_id` ONCE, under a DB advisory lock, instead of leaving
   * de-duplication to each adapter's own in-memory cache (empty on every restart).
   */
  ensureFolder(tenantFolder: string): Promise<string>;

  /**
   * Seeds the adapter's in-memory folder cache with an already-known id (read from
   * `tenants.drive_folder_id` by the caller) so the next `ensureFolder`/
   * `uploadResumable` call for `tenantFolder` skips resolution entirely (fix pass 8,
   * finding 2).
   */
  primeFolder(tenantFolder: string, folderId: string): void;
  /** Fix pass 10 (critic N-13): drop a cached folder id the provider reported as gone,
   * so the next `ensureFolder` looks up / re-creates instead of targeting a dead id. */
  forgetFolder(tenantFolder: string): void;

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

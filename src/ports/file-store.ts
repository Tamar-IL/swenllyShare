import type { Readable } from 'node:stream';

/**
 * Zoho WorkDrive — the raw file store behind the *distribution link* (architecture.md §2,
 * §6). This is the AC-U2 default path: `zoho_public_link` is handed to the sender with no
 * server involvement per download. The branded page (`GET /s/:slug`, AC-U3) still routes
 * downloads through `openDownload` so the raw Zoho URL never appears in a response.
 */
export interface FileStorePort {
  /** Uploads `stream` (exactly `sizeBytes` long) into `tenantFolder`, named `name`. */
  upload(
    tenantFolder: string,
    stream: Readable,
    sizeBytes: number,
    name: string,
  ): Promise<{ resourceId: string }>;

  /**
   * Resolves `tenantFolder` (== the caller's `tenantId`) to a real WorkDrive folder id,
   * creating it if none exists yet. `upload()` already calls this internally (so this
   * suite's plain contract tests, which call `upload()` directly with no orchestration
   * around it, keep working unchanged) — it is exposed on the port separately so
   * `FilesService.publishFile` (fix pass 8, code-review.md polish-pass finding 2) can
   * resolve-and-persist a tenant's folder id to `tenants.zoho_folder_id` ONCE, under a DB
   * advisory lock, instead of leaving de-duplication to each adapter's own in-memory
   * cache (which is empty on every process restart and has no cross-process lock).
   */
  ensureFolder(tenantFolder: string): Promise<string>;

  /**
   * Seeds the adapter's in-memory folder cache with an already-known id (read from
   * `tenants.zoho_folder_id` by the caller) so the next `ensureFolder`/`upload` call for
   * `tenantFolder` skips resolution entirely — the fast path that keeps the DB, not the
   * cache, as the source of truth across a restart (fix pass 8, finding 2).
   */
  primeFolder(tenantFolder: string, folderId: string): void;

  /**
   * Creates (or returns the existing) public link for `resourceId`. `embedToken` is
   * `null` when the provider's response carried no distinct embed identifier (fix pass 5,
   * F-E, `docs/reviews/critic-report.md`) — callers must NEVER derive one from `url`'s own
   * path (that would put the raw link's identifying token back into whatever renders the
   * embed, defeating the entire point of the branded page). A `null` embedToken means
   * render the branded page without an iframe, not fall back to any raw-link-derived
   * value.
   */
  createPublicLink(
    resourceId: string,
    opts: { allowDownload: boolean },
  ): Promise<{ linkId: string; url: string; embedToken: string | null }>;

  /** Revokes a previously created public link — part of `file.expire` (architecture.md §7). */
  revokeLink(linkId: string): Promise<void>;

  /** Opens a byte stream for the branded page's proxied download (`/s/:slug/download`). */
  openDownload(resourceId: string): Promise<Readable>;

  /** Deletes the underlying Zoho object — part of file deletion. */
  delete(resourceId: string): Promise<void>;
}

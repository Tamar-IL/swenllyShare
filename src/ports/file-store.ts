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

  /** Creates (or returns the existing) public link for `resourceId`. */
  createPublicLink(
    resourceId: string,
    opts: { allowDownload: boolean },
  ): Promise<{ linkId: string; url: string; embedToken: string }>;

  /** Revokes a previously created public link — part of `file.expire` (architecture.md §7). */
  revokeLink(linkId: string): Promise<void>;

  /** Opens a byte stream for the branded page's proxied download (`/s/:slug/download`). */
  openDownload(resourceId: string): Promise<Readable>;

  /** Deletes the underlying Zoho object — part of file deletion. */
  delete(resourceId: string): Promise<void>;
}

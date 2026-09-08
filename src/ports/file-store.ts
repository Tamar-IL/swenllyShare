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

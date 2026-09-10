import { Readable } from 'node:stream';
import type { FileStorePort } from '../../ports/file-store.js';
import { NotFoundError } from '../../ports/errors.js';

interface FakeResource {
  tenantFolder: string;
  // Fix pass 7 (critic-report.md #6, architecture.md §3/§5): mirrors the real adapter's
  // `ensureFolder` cache — every resource records the (cached, per-tenant-name) folder
  // id it landed under, so a test can assert every upload for one tenant shares the
  // SAME folder id and a different tenant gets a DIFFERENT one, without modeling real
  // WorkDrive folder semantics.
  folderId: string;
  name: string;
  bytes: Buffer;
  sizeBytes: number;
}

interface FakeLink {
  resourceId: string;
  url: string;
  embedToken: string | null;
  revoked: boolean;
}

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

/**
 * Semantic fake for `FileStorePort` (Zoho WorkDrive): mints deterministic public
 * links/embed tokens from the resource id (so tests can predict them), tracks
 * revocation, and actually buffers uploaded bytes so `openDownload` round-trips real
 * content — this is what makes the branded-page download test (AC-U3) meaningful
 * without a live Zoho account.
 */
export class FakeFileStore implements FileStorePort {
  readonly resources = new Map<string, FakeResource>();
  readonly links = new Map<string, FakeLink>();
  /** Fix pass 7 (#6): tenant folder NAME -> folder id, mirroring the real adapter's
   * in-process `ensureFolder` cache. Test inspection: `folders.size` is the number of
   * DISTINCT tenant folders ever created, regardless of how many uploads happened
   * within each. */
  readonly folders = new Map<string, string>();

  private resolveFolder(name: string): string {
    let folderId = this.folders.get(name);
    if (!folderId) {
      folderId = nextId('zoho-folder');
      this.folders.set(name, folderId);
    }
    return folderId;
  }

  /** Fix pass 8 (code-review.md polish-pass finding 2): part of `FileStorePort` now —
   * `FilesService.publishFile` calls this directly (under its own DB advisory lock) the
   * first time a tenant needs a folder, then persists the result to
   * `tenants.zoho_folder_id`. No lookup-by-name fallback here (unlike the real adapters):
   * this fake has no server-side state to look anything up against, so a "restart"
   * scenario (a brand-new `FakeFileStore` instance) relies entirely on the caller priming
   * the new instance's cache via `primeFolder` with the DB-known id. */
  async ensureFolder(name: string): Promise<string> {
    return this.resolveFolder(name);
  }

  /** Test/production seam: seeds this instance's cache with an already-known id (read
   * from the DB by the caller) so a later `upload()`/`ensureFolder()` call for `name`
   * never mints a fresh one — see `FileStorePort.primeFolder`'s doc comment. */
  primeFolder(name: string, folderId: string): void {
    this.folders.set(name, folderId);
  }

  forgetFolder(name: string): void {
    this.folders.delete(name);
  }
  /** Fix pass 5, F-E test seam: forces the NEXT `createPublicLink` call to return
   * `embedToken: null`, the same shape the real adapter returns whenever Zoho's response
   * carries no `embed_url`/`embed_link` field — lets tests exercise the branded page's
   * no-iframe fallback (`GET /s/:slug`) through the normal publish flow instead of only
   * via direct DB manipulation. One-shot, like `crashAfterNextCopy` on the Drive fake. */
  private forceNullEmbedTokenNext = false;

  forceNullEmbedTokenOnNextLink(): void {
    this.forceNullEmbedTokenNext = true;
  }

  async upload(
    tenantFolder: string,
    stream: Readable,
    sizeBytes: number,
    name: string,
  ): Promise<{ resourceId: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks);
    const resourceId = nextId('zoho-res');
    const folderId = this.resolveFolder(tenantFolder);
    this.resources.set(resourceId, { tenantFolder, folderId, name, bytes, sizeBytes });
    return { resourceId };
  }

  async createPublicLink(
    resourceId: string,
    _opts: { allowDownload: boolean },
  ): Promise<{ linkId: string; url: string; embedToken: string | null }> {
    if (!this.resources.has(resourceId)) {
      throw new NotFoundError(`fake zoho: no such resource ${resourceId}`);
    }
    const linkId = nextId('zoho-link');
    const url = `https://workdrive.zohoexternal.com/file/fake/${resourceId}`;
    // Deliberately NOT derived from `resourceId` (unlike `url` above): a real embed token
    // is an opaque Zoho identifier unrelated to the internal resource id, and AC-U3 tests
    // that the branded page never leaks the raw resource id — an embed token that
    // literally contained it would make the fake fail to catch a real leak.
    const embedToken = this.forceNullEmbedTokenNext ? null : nextId('embed-tok');
    this.forceNullEmbedTokenNext = false;
    this.links.set(linkId, { resourceId, url, embedToken, revoked: false });
    return { linkId, url, embedToken };
  }

  async revokeLink(linkId: string): Promise<void> {
    const link = this.links.get(linkId);
    if (!link) return;
    link.revoked = true;
  }

  async openDownload(resourceId: string): Promise<Readable> {
    const resource = this.resources.get(resourceId);
    if (!resource) {
      throw new NotFoundError(`fake zoho: no such resource ${resourceId}`);
    }
    return Readable.from(resource.bytes);
  }

  async delete(resourceId: string): Promise<void> {
    this.resources.delete(resourceId);
  }
}

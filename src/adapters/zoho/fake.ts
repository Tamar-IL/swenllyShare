import { Readable } from 'node:stream';
import type { FileStorePort } from '../../ports/file-store.js';
import { NotFoundError } from '../../ports/errors.js';

interface FakeResource {
  tenantFolder: string;
  name: string;
  bytes: Buffer;
  sizeBytes: number;
}

interface FakeLink {
  resourceId: string;
  url: string;
  embedToken: string;
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
    this.resources.set(resourceId, { tenantFolder, name, bytes, sizeBytes });
    return { resourceId };
  }

  async createPublicLink(
    resourceId: string,
    _opts: { allowDownload: boolean },
  ): Promise<{ linkId: string; url: string; embedToken: string }> {
    if (!this.resources.has(resourceId)) {
      throw new NotFoundError(`fake zoho: no such resource ${resourceId}`);
    }
    const linkId = nextId('zoho-link');
    const url = `https://workdrive.zohoexternal.com/file/fake/${resourceId}`;
    // Deliberately NOT derived from `resourceId` (unlike `url` above): a real embed token
    // is an opaque Zoho identifier unrelated to the internal resource id, and AC-U3 tests
    // that the branded page never leaks the raw resource id — an embed token that
    // literally contained it would make the fake fail to catch a real leak.
    const embedToken = nextId('embed-tok');
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

import type { Readable } from 'node:stream';
import type { FileStorePort } from '../../ports/file-store.js';

export interface ZohoFileStoreConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  teamFolderId: string;
}

/**
 * Real Zoho WorkDrive adapter. Every method below is `@unverified-live` (architecture.md
 * §2, §9, §12): no live call to Zoho's API has been made by anyone on this project, and
 * the chunked-upload / create-link / role-id shapes are all spikes, not confirmed
 * contracts. The adapters engineer fills these in against a real account; this stub only
 * fixes the class shape and constructor config so `container.ts` and callers never change
 * when that happens.
 */
export class ZohoFileStore implements FileStorePort {
  constructor(private readonly config: ZohoFileStoreConfig) {}

  /** @unverified-live */
  async upload(
    _tenantFolder: string,
    _stream: Readable,
    _sizeBytes: number,
    _name: string,
  ): Promise<{ resourceId: string }> {
    throw new Error('not implemented: ZohoFileStore.upload');
  }

  /** @unverified-live */
  async createPublicLink(
    _resourceId: string,
    _opts: { allowDownload: boolean },
  ): Promise<{ linkId: string; url: string; embedToken: string }> {
    throw new Error('not implemented: ZohoFileStore.createPublicLink');
  }

  /** @unverified-live */
  async revokeLink(_linkId: string): Promise<void> {
    throw new Error('not implemented: ZohoFileStore.revokeLink');
  }

  /** @unverified-live */
  async openDownload(_resourceId: string): Promise<Readable> {
    throw new Error('not implemented: ZohoFileStore.openDownload');
  }

  /** @unverified-live */
  async delete(_resourceId: string): Promise<void> {
    throw new Error('not implemented: ZohoFileStore.delete');
  }
}

import type { Readable } from 'node:stream';
import type { DriveSharePort } from '../../ports/drive-share.js';

export interface GoogleDriveShareConfig {
  credentialMode: 'service_account' | 'oauth_refresh';
  saJsonPath?: string;
  impersonateSubject?: string;
  sharedDriveId?: string;
  rootFolderId?: string;
}

/**
 * Real Google Drive adapter (Drive v3 via `undici` + service-account/domain-wide
 * delegation, architecture.md §1, §2). Every method is `@unverified-live`: the real share
 * ceiling, the exact 403 `errors[].reason` values that should classify as
 * `QuotaClassError`, and visitor (no-Google-account) sharing are all unverified spikes
 * (architecture.md §12). The adapters engineer fills these in; this stub only fixes the
 * shape.
 */
export class GoogleDriveShare implements DriveSharePort {
  constructor(private readonly config: GoogleDriveShareConfig) {}

  /** @unverified-live */
  async uploadResumable(
    _stream: Readable,
    _sizeBytes: number,
    _name: string,
    _mime: string,
  ): Promise<{ driveFileId: string }> {
    throw new Error('not implemented: GoogleDriveShare.uploadResumable');
  }

  /** @unverified-live */
  async copy(_driveFileId: string, _intentKey: string): Promise<{ driveFileId: string }> {
    throw new Error('not implemented: GoogleDriveShare.copy');
  }

  /** @unverified-live */
  async findByIntent(_intentKey: string): Promise<{ driveFileId: string } | undefined> {
    throw new Error('not implemented: GoogleDriveShare.findByIntent');
  }

  /** @unverified-live */
  async sharePermission(_driveFileId: string, _email: string): Promise<{ permissionId: string }> {
    throw new Error('not implemented: GoogleDriveShare.sharePermission');
  }

  /** @unverified-live */
  async revokeAll(_driveFileId: string): Promise<void> {
    throw new Error('not implemented: GoogleDriveShare.revokeAll');
  }

  /** @unverified-live */
  async delete(_driveFileId: string): Promise<void> {
    throw new Error('not implemented: GoogleDriveShare.delete');
  }
}

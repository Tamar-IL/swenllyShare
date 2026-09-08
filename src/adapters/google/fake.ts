import type { Readable } from 'node:stream';
import type { DriveSharePort } from '../../ports/drive-share.js';
import { QuotaClassError } from '../../ports/errors.js';

interface FakeDriveFile {
  name: string;
  mime: string;
  bytes: Buffer;
  appProperties: Record<string, string>;
  permissions: Set<string>;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `drive-file-${counter}`;
}

/**
 * Semantic fake for `DriveSharePort` (architecture.md §5). Encodes the two behaviors the
 * SharingEngine tests actually exercise:
 *
 *  - **Reactive quota**: `sharePermission` throws `QuotaClassError` once a `driveFileId`
 *    has accumulated `quotaPerFile` permissions — a stand-in for Drive's real,
 *    undocumented, velocity-based sharing ceiling (architecture.md §5, `research/05 §1`).
 *    Configurable per test via the constructor or `setQuotaPerFile`.
 *  - **Crash-after-copy recovery**: `crashAfterNextCopy()` arms a one-shot fault that lets
 *    `copy()` perform its state mutation (the new file + its `appProperties.swenllyIntent`
 *    stamp both really exist afterward) but then throws before returning — simulating a
 *    process crash between the external call succeeding and the caller's local commit.
 *    A subsequent `provision()` call recovers via `findByIntent`, per architecture.md §5.
 */
export class FakeDriveShare implements DriveSharePort {
  private readonly files = new Map<string, FakeDriveFile>();
  private readonly intentIndex = new Map<string, string>();
  private armedCrash = false;

  constructor(private quotaPerFile: number = Number.POSITIVE_INFINITY) {}

  setQuotaPerFile(n: number): void {
    this.quotaPerFile = n;
  }

  crashAfterNextCopy(): void {
    this.armedCrash = true;
  }

  /** Test inspection: how many active permissions a given Drive file currently holds. */
  permissionCount(driveFileId: string): number {
    return this.files.get(driveFileId)?.permissions.size ?? 0;
  }

  /** Test inspection: total number of distinct Drive files this fake has ever created. */
  get fileCount(): number {
    return this.files.size;
  }

  async uploadResumable(
    stream: Readable,
    _sizeBytes: number,
    name: string,
    mime: string,
  ): Promise<{ driveFileId: string }> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const driveFileId = nextId();
    this.files.set(driveFileId, {
      name,
      mime,
      bytes: Buffer.concat(chunks),
      appProperties: {},
      permissions: new Set(),
    });
    return { driveFileId };
  }

  async copy(driveFileId: string, intentKey: string): Promise<{ driveFileId: string }> {
    const source = this.files.get(driveFileId);
    if (!source) {
      throw new Error(`fake drive: copy source ${driveFileId} does not exist`);
    }
    const newId = nextId();
    this.files.set(newId, {
      name: source.name,
      mime: source.mime,
      bytes: source.bytes,
      appProperties: { swenllyIntent: intentKey },
      permissions: new Set(),
    });
    this.intentIndex.set(intentKey, newId);

    if (this.armedCrash) {
      this.armedCrash = false;
      throw new Error('fake drive: injected crash after copy, before caller commit');
    }
    return { driveFileId: newId };
  }

  async findByIntent(intentKey: string): Promise<{ driveFileId: string } | undefined> {
    const driveFileId = this.intentIndex.get(intentKey);
    return driveFileId ? { driveFileId } : undefined;
  }

  async sharePermission(driveFileId: string, email: string): Promise<{ permissionId: string }> {
    const file = this.files.get(driveFileId);
    if (!file) {
      throw new Error(`fake drive: sharePermission target ${driveFileId} does not exist`);
    }
    if (file.permissions.size >= this.quotaPerFile) {
      throw new QuotaClassError(`fake drive: sharingRateLimitExceeded on ${driveFileId}`);
    }
    file.permissions.add(email.toLowerCase());
    return { permissionId: `perm-${driveFileId}-${email.toLowerCase()}` };
  }

  async revokeAll(driveFileId: string): Promise<void> {
    const file = this.files.get(driveFileId);
    if (file) file.permissions.clear();
  }

  async delete(driveFileId: string): Promise<void> {
    this.files.delete(driveFileId);
  }
}

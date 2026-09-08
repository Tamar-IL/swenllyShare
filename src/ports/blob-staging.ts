import type { Readable } from 'node:stream';

/**
 * Local (or eventually object-store) staging for uploaded bytes, ahead of the
 * `file.publish` job's Zoho/Drive uploads (architecture.md §2, §6). The real adapter is
 * local disk in MVP; ids are always server-generated — no user-supplied path ever reaches
 * the filesystem (architecture.md §10).
 */
export interface BlobStagingPort {
  /** Streams `stream` to storage under a fresh id, never buffering it in memory. Returns
   * the number of bytes actually written, for the caller to cross-check against any
   * client-declared size. */
  put(id: string, stream: Readable): Promise<{ bytes: number }>;

  /** Opens a read stream for a previously staged blob. Throws `NotFoundError` if absent. */
  open(id: string): Promise<Readable>;

  /** Returns size/existence for a staged blob, or `undefined` if it has been purged/never existed. */
  stat(id: string): Promise<{ bytes: number } | undefined>;

  /** Removes a staged blob. A no-op (not an error) if it is already gone. */
  remove(id: string): Promise<void>;

  /** Generates a fresh, unguessable staging id — the only id `put` is ever called with. */
  newId(): string;
}

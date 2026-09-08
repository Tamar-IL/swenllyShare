import type { Readable } from 'node:stream';

/** Reads a `Readable` fully into a `Buffer`. Only ever used for content already bounded by
 * `ATTACH_LIMIT_BYTES` (architecture.md §4.11) — never for an unbounded upload stream. */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

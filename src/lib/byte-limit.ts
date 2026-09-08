import { Transform } from 'node:stream';

/** Thrown by `limitStream` when the source exceeds `maxBytes`. `Files.createStaged` maps
 * this to `AppError(TOO_LARGE, 413)` (architecture.md §6, route table). */
export class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`payload exceeds the ${maxBytes}-byte limit`);
    this.name = 'PayloadTooLargeError';
  }
}

/**
 * Wraps `source` in a pass-through `Transform` that destroys the stream with
 * `PayloadTooLargeError` the instant more than `maxBytes` have flowed through it — a hard
 * cap enforced at the domain layer (not just relying on the HTTP framework's own limit),
 * so `BlobStagingPort.put` never writes an unbounded upload to disk (architecture.md §6).
 */
export function limitStream(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      seen += chunk.length;
      if (seen > maxBytes) {
        callback(new PayloadTooLargeError(maxBytes));
        return;
      }
      callback(null, chunk);
    },
  });
}

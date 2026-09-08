import { randomBytes } from 'node:crypto';

/**
 * Crockford base32 alphabet, lowercase. No I/L/O/U — avoids ambiguity in tokens that a
 * human might read aloud or transcribe from a mailto/URL (architecture.md §10).
 */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * Encodes `bytes` as lowercase Crockford base32 (no padding). Pure bit-packing — 5 bits
 * per output character, most-significant-bit first.
 */
export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
}

/**
 * Generates an opaque, URL- and mailto-safe token with at least `bits` of entropy,
 * Crockford base32 lowercase encoded (architecture.md §10: 130 bits for
 * `request_token`/`public_slug`/magic-link tokens, 128 for session ids).
 *
 * `bits` is rounded up to a whole byte before generation, so the returned string may
 * carry a few bits more entropy than requested, never fewer.
 */
export function opaqueToken(bits: number): string {
  if (!Number.isInteger(bits) || bits <= 0) {
    throw new Error(`opaqueToken: bits must be a positive integer, got ${bits}`);
  }
  const byteLength = Math.ceil(bits / 8);
  return encodeBase32(randomBytes(byteLength));
}

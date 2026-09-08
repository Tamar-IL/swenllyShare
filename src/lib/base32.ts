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

/**
 * Like `opaqueToken`, but rounds `bits` up to a whole base32 *character* (5 bits) instead
 * of a whole byte, and trims the output to exactly that many characters.
 *
 * Why this exists: the inbound-address grammar (architecture.md §4.3) embeds
 * `request_token` in a fixed-width regex group — `[a-z0-9]{26}` for a 130-bit token,
 * because 26 × 5 = 130 exactly. `opaqueToken(130)` cannot produce that: it rounds 130 bits
 * up to 17 whole bytes (136 bits) *before* encoding, and emits all of them, yielding 28
 * characters. `opaqueTokenExact(130)` generates the same 17 bytes of underlying randomness
 * but truncates the encoded string to `ceil(bits / 5)` = 26 characters — since
 * `encodeBase32` emits characters as a contiguous, most-significant-bit-first bitstream,
 * those first 26 characters are exactly the requested 130 bits, still fully random and
 * lossless; only the final 1-2 leftover characters (never-needed padding bits) are
 * discarded. Used for `request_token`, `public_slug`, and session ids — anywhere a value
 * is embedded in a fixed-width wire format rather than only ever compared as an opaque
 * whole.
 */
export function opaqueTokenExact(bits: number): string {
  if (!Number.isInteger(bits) || bits <= 0) {
    throw new Error(`opaqueTokenExact: bits must be a positive integer, got ${bits}`);
  }
  const chars = Math.ceil(bits / 5);
  const byteLength = Math.ceil((chars * 5) / 8);
  return encodeBase32(randomBytes(byteLength)).slice(0, chars);
}

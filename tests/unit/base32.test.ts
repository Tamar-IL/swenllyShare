import { describe, expect, it } from 'vitest';
import { encodeBase32, opaqueToken } from '../../src/lib/base32.js';

// Crockford base32: lowercase, digits 0-9 and letters a-z minus i, l, o, u.
const CROCKFORD_CHARSET_RE = /^[0-9a-hjkmnp-tv-z]+$/;

describe('encodeBase32', () => {
  it('produces only lowercase Crockford-alphabet characters', () => {
    const encoded = encodeBase32(new Uint8Array([0, 1, 2, 253, 254, 255]));
    expect(encoded).toMatch(CROCKFORD_CHARSET_RE);
    expect(encoded).toBe(encoded.toLowerCase());
  });

  it('never emits i, l, o, or u', () => {
    // Exhaustive over every byte value gives every 5-bit group at least once.
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i++) bytes[i] = i;
    const encoded = encodeBase32(bytes);
    expect(encoded).not.toMatch(/[ilou]/i);
  });

  it('is deterministic for the same input', () => {
    const input = new Uint8Array([10, 20, 30, 40]);
    expect(encodeBase32(input)).toBe(encodeBase32(input));
  });

  it('encodes an empty input as an empty string', () => {
    expect(encodeBase32(new Uint8Array([]))).toBe('');
  });
});

describe('opaqueToken', () => {
  it('produces the expected length for 128 bits (26 chars, ceil(128/5))', () => {
    const token = opaqueToken(128);
    expect(token).toHaveLength(26);
  });

  it('produces the expected length for 130 bits (26 chars, ceil(130/8)=17 bytes -> ceil(136/5)=28)', () => {
    // 130 bits rounds up to 17 whole bytes (136 bits) before encoding.
    const token = opaqueToken(130);
    expect(token).toHaveLength(28);
  });

  it('only ever contains lowercase Crockford-alphabet characters', () => {
    for (let i = 0; i < 20; i++) {
      expect(opaqueToken(128)).toMatch(CROCKFORD_CHARSET_RE);
    }
  });

  it('is not predictable across calls', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => opaqueToken(128)));
    expect(tokens.size).toBe(50);
  });

  it('rejects non-positive or non-integer bit counts', () => {
    expect(() => opaqueToken(0)).toThrow();
    expect(() => opaqueToken(-8)).toThrow();
    expect(() => opaqueToken(12.5)).toThrow();
  });
});

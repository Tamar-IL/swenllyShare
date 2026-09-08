/**
 * Opaque capability-token generation (architecture.md §2, §10). The only user of
 * `crypto.randomBytes` in the domain layer goes through here, so tests can substitute a
 * deterministic generator without touching `node:crypto` directly.
 */
export interface TokenGen {
  /** Returns a lowercase Crockford base32 string with at least `bits` of entropy. */
  opaque(bits: number): string;
}

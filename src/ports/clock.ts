/**
 * The one source of "now" and "wait" in the codebase (architecture.md §2). Every domain
 * service and job handler that reasons about time takes a `Clock` rather than calling
 * `Date.now()`/`setTimeout` directly, so tests can advance virtual time deterministically
 * (expiry, pacing, backoff) without real sleeps.
 */
export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}

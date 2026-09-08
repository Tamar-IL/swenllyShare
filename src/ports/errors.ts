/**
 * Typed error taxonomy for port adapters (architecture.md §2, §5). Adapters translate a
 * protocol-specific failure into one of these; domain services branch on the class, never
 * on a raw HTTP status or provider error string, so a wrong guess about a live API's exact
 * shape costs one adapter's `classify` function, not a scattered set of `if` checks.
 */

/** Base class for every classified port error. Always carries the adapter's raw cause. */
export class PortError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PortError';
    this.cause = options?.cause;
  }
}

/**
 * The external provider is signaling "you have hit an abuse/rate ceiling" — for
 * `DriveSharePort.sharePermission`, this is Drive's opaque, velocity-based sharing limit
 * (architecture.md §5, `research/05 §1`). `SharingEngine` reacts to this by retiring the
 * current copy and provisioning a new one. Never hard-code the threshold that triggers
 * this — only classify the provider's error.
 */
export class QuotaClassError extends PortError {
  constructor(message = 'quota/rate limit exceeded', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'QuotaClassError';
  }
}

/**
 * Retrying the same call again, later, has a reasonable chance of succeeding (network
 * blip, 5xx, timeout). Job handlers retry on this with backoff; nothing about the request
 * itself was wrong.
 */
export class TransientError extends PortError {
  constructor(message = 'transient failure', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TransientError';
  }
}

/**
 * Retrying will never succeed without a different input or configuration (bad
 * credentials, 4xx other than quota, a resource that no longer exists). Job handlers
 * dead-letter on this rather than burning through `JOB_MAX_ATTEMPTS`.
 */
export class PermanentError extends PortError {
  constructor(message = 'permanent failure', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PermanentError';
  }
}

/** The referenced external resource (file, link, permission) does not exist any more. */
export class NotFoundError extends PortError {
  constructor(message = 'not found', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NotFoundError';
  }
}

/**
 * Fix pass 5, F-A (`docs/reviews/critic-report.md`): the request was written to the wire
 * but nothing came back to say whether the provider received it — a socket timeout after
 * the body was sent, a connection reset mid-response, a process crash between "sent the
 * bytes" and "read the ack". Unlike `TransientError`/`PermanentError` (both mean a
 * *completed* HTTP exchange told us, definitively, that the send did or didn't happen),
 * an `AmbiguousSendError` means we genuinely don't know. Never safe to blindly retry (the
 * provider may already have it — retrying risks a duplicate disclosure) and never safe to
 * treat as delivered (the provider may not have it — claiming `sent` would be a lie in the
 * audit log). Callers must record this outcome honestly as unresolved (`deliveries.outcome
 * = 'unconfirmed'`, `src/jobs/handlers/delivery-fulfill.ts`) rather than guessing either way.
 */
export class AmbiguousSendError extends PortError {
  constructor(message = 'ambiguous send outcome', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AmbiguousSendError';
  }
}

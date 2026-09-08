/**
 * The fixed vocabulary for `{error: <code>, message?: string}` JSON error bodies
 * (architecture.md §11: "Every JSON error body is `{error: <code>, message?: <string>}`
 * with codes from `lib/errors.ts`"). Codes below are the ones the brief names or implies
 * by HTTP status in the route table (§11) and the pipeline/status enums (§3-4); Lane B
 * adds route-specific codes here as handlers are built — this file is the one place new
 * codes get named, never inlined at a call site.
 */
export const ErrorCode = {
  // Upload (POST /api/files)
  TOO_LARGE: 'too_large',
  UNSUPPORTED_MEDIA: 'unsupported_media',

  // Auth / session
  UNAUTHORIZED: 'unauthorized',
  INVALID_TOKEN: 'invalid_token',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_CONSUMED: 'token_consumed',

  // CSRF
  INVALID_CSRF: 'invalid_csrf',

  // Generic REST
  NOT_FOUND: 'not_found',
  VALIDATION_ERROR: 'validation_error',
  RATE_LIMITED: 'rate_limited',
  INTERNAL_ERROR: 'internal_error',

  // Public share page / download (GET /s/:slug, /s/:slug/download)
  EXPIRED: 'expired',

  // Webhook (POST /webhooks/mailgun/inbound)
  BAD_SIGNATURE: 'bad_signature',
  UNROUTABLE: 'unroutable',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, statusCode: number, message?: string) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

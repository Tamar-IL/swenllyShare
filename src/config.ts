import { z } from 'zod';

/**
 * `config.ts` parses `process.env` through this schema once, at boot, and fails fast.
 * No module anywhere else in the codebase should read `process.env` directly — inject
 * the parsed `Config` instead. See architecture.md §9.
 */

// zod's `z.coerce.boolean()` treats any non-empty string (including the literal "false")
// as truthy, which is exactly wrong for env vars. This preprocessor maps the literal
// strings "true"/"false" (case-insensitive) explicitly and leaves booleans as-is.
function boolFromEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
    }
    return value;
  }, z.boolean());
}

function intFromEnv(defaultValue: number, opts?: { min?: number }) {
  return z.preprocess(
    (value) => {
      if (value === undefined || value === '') return defaultValue;
      return value;
    },
    z.coerce
      .number()
      .int()
      .refine((n) => (opts?.min === undefined ? true : n >= opts.min), {
        message: `must be >= ${opts?.min}`,
      }),
  );
}

const baseConfigSchema = z.object({
  // --- Core ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(3000, { min: 1 }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().url({ message: 'PUBLIC_BASE_URL must be an absolute URL' }),
  INBOUND_DOMAIN: z.string().min(1, 'INBOUND_DOMAIN is required'),

  // --- Database ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PGPOOL_MAX: intFromEnv(10, { min: 1 }),
  // Explicitly turns on `ssl` for the pg.Pool (src/db/pool.ts), independent of whatever
  // `DATABASE_URL` says. In production, `createPool` fails fast unless this is `true` OR
  // `DATABASE_URL` itself carries `sslmode=require|verify-ca|verify-full` (finding #7,
  // docs/security/appsec-review.md).
  PG_SSL: boolFromEnv(false),

  // --- Sessions / cookies ---
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  // No fixed default in architecture.md §9: secure cookies are the safe default outside
  // dev, so the runtime default is derived from NODE_ENV in `loadConfig`, not here.
  COOKIE_SECURE: boolFromEnv(true).optional(),

  // --- Adapter mode ---
  ADAPTERS: z.enum(['fake', 'real']).default('fake'),
  // e.g. "drive=fake,zoho=real" — dev-only per-port override, parsed by container.ts.
  ADAPTER_OVERRIDES: z.string().optional(),

  // --- Branded page ---
  BRANDED_PAGE_ENABLED: boolFromEnv(false),

  // --- Upload / attachment limits ---
  ATTACH_LIMIT_BYTES: intFromEnv(20_971_520, { min: 1 }),
  // Fix pass 5, F-G (docs/reviews/critic-report.md): defaults to the CORROBORATED simple-
  // upload ceiling (250MB, `SIMPLE_UPLOAD_MAX_BYTES` in src/adapters/zoho/real.ts — a
  // public reference implementation and community threads, not a primary Zoho doc page,
  // but at least corroborated). The `>250MB` chunked large-file path is a MODELED guess
  // with no field-level confirmation found anywhere (that method's own doc comment says
  // so) — routing real customer files into it by default, up to the old 1GB ceiling, sent
  // every upload above 250MB into invented code. Raise only after spike 1
  // (docs/runbooks/live-spikes.md) confirms the large-file shape, or set
  // ZOHO_LARGE_UPLOAD_ENABLED=true once a founder has explicitly accepted that risk.
  MAX_UPLOAD_BYTES: intFromEnv(262_144_000, { min: 1 }),
  // Fix pass 5, F-G: the real Zoho adapter refuses (PermanentError, not a silent attempt)
  // to route a file into the unverified large-file chunked-upload path unless this is
  // explicitly set — see src/adapters/zoho/real.ts.
  ZOHO_LARGE_UPLOAD_ENABLED: boolFromEnv(false),

  // --- Staging ---
  STAGING_DIR: z.string().default('./staging'),
  STAGING_RETENTION_HOURS: intFromEnv(24, { min: 0 }),

  // --- SharingEngine ---
  DRIVE_SHARE_SOFT_CAP: intFromEnv(500, { min: 1 }),
  SHARE_PACE_MIN_INTERVAL_MS: intFromEnv(1500, { min: 0 }),

  // --- Expiry ---
  DEFAULT_EXPIRY_DAYS: intFromEnv(30, { min: 1 }),

  // --- Rate limits (business limits, in Postgres) ---
  RATE_REQUESTER_PER_HOUR: intFromEnv(5, { min: 1 }),
  RATE_FILE_PER_HOUR: intFromEnv(60, { min: 1 }),
  RATE_TENANT_PER_HOUR: intFromEnv(300, { min: 1 }),
  RATE_MAGICLINK_PER_HOUR: intFromEnv(5, { min: 1 }),
  // F-8 (red-team RT-30/RT-30b/RT-31): a per-requester-domain ceiling, checked alongside
  // the per-file bucket so a single domain (or catch-all mailbox) cannot silently consume
  // a whole file's hourly budget. Default sits well below the default RATE_FILE_PER_HOUR
  // (60) — see `src/domain/rate-limit.ts` for the file-fairness logic this pairs with.
  RATE_DOMAIN_PER_HOUR: intFromEnv(30, { min: 1 }),

  // --- Inbound retention ---
  RAW_PAYLOAD_RETENTION_DAYS: intFromEnv(7, { min: 0 }),
  // F-7: pre-authentication quarantine writes (pipeline gates 4-6, all of which can write
  // before gate 7's rate check) are bounded per resolved request-token, per hour, in
  // Postgres — beyond the cap, the request is still answered 200 but nothing more is
  // written (`src/domain/request-pipeline.ts`).
  QUARANTINE_PER_TOKEN_PER_HOUR: intFromEnv(5, { min: 1 }),

  // --- Google ---
  GOOGLE_CREDENTIAL_MODE: z.enum(['service_account', 'oauth_refresh']).default('service_account'),
  GOOGLE_SA_JSON_PATH: z.string().optional(),
  GOOGLE_IMPERSONATE_SUBJECT: z.string().optional(),
  GOOGLE_SHARED_DRIVE_ID: z.string().optional(),
  GOOGLE_ROOT_FOLDER_ID: z.string().optional(),
  // `oauth_refresh` mode only (advisor-consult.md §4 founder-fork: no Workspace, a
  // dedicated Gmail + production-published OAuth client). Added alongside the real
  // adapter that consumes them — see src/adapters/google/real.ts.
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_OAUTH_REFRESH_TOKEN: z.string().optional(),

  // --- Zoho ---
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_REFRESH_TOKEN: z.string().optional(),
  ZOHO_API_BASE: z.string().optional(),
  ZOHO_TEAM_FOLDER_ID: z.string().optional(),
  // OAuth token-endpoint host — defaults to the global DC inside the adapter
  // (accounts.zoho.com) when unset. EU/IN/AU/CN/JP data centers need their own host
  // (architecture.md §2) — see src/adapters/zoho/real.ts.
  ZOHO_ACCOUNTS_BASE: z.string().optional(),
  // WorkDrive `role_id` for a created external link — community-reported default "6"
  // (view); see src/adapters/zoho/real.ts for the full mapping and its confidence level.
  ZOHO_LINK_ROLE_ID: z.string().default('6'),

  // --- Mailgun ---
  MAILGUN_API_BASE: z.string().optional(),
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_SIGNING_KEY: z.string().optional(),
  MAILGUN_SENDING_DOMAIN: z.string().optional(),
  OUTBOUND_FROM: z.string().optional(),
  // F-1: the RFC 8601 `authserv-id` our own DMARC/SPF/DKIM verdict should be filed under
  // in a captured `Authentication-Results` header (`src/adapters/mailgun/mapping.ts`).
  // No fixed default in this schema — `@unverified-live` until a real payload is captured
  // (docs/runbooks/live-spikes.md spike #3). Fix pass 6 (N-8): `container.ts` no longer
  // falls back to `INBOUND_DOMAIN` when this is unset — that fallback was deleted (fix
  // pass 5, F-B); the only fallback left is `mapping.ts`'s own hardcoded, non-domain-
  // specific default (`mailgun.org`), used only where `loadConfig`'s cross-field check
  // below didn't require this var (dev/test with fake adapters and the inbound path off).
  MAILGUN_AUTHSERV_ID: z.string().optional(),
  // F-B (fix pass 6): which ONE source `mapMailgunInboundPayload` trusts for DMARC/SPF/DKIM
  // — `mailgun-fields` (Mailgun's synthetic top-level fields) or `authentication-results`
  // (the RFC 8601 header inside `message-headers`, exact authserv-id match). No `both`: a
  // fallback between sources is a second door an attacker can choose. Set after spike 3
  // (docs/runbooks/live-spikes.md) shows which signal Mailgun actually provides.
  INBOUND_AUTH_SOURCE: z
    .enum(['authentication-results', 'mailgun-fields'])
    .default('mailgun-fields'),
  // F-1 kill switch: the inbound email-request path stays gated behind this until a live
  // Mailgun payload has been captured and the auth-results field guess above is confirmed
  // (architecture.md §12's unverified item). `false` still 401/406s on a bad signature or
  // malformed address (those gates never depended on the auth-results guess) but every
  // otherwise-valid webhook is quarantined with reason `inbound_disabled` instead of ever
  // reaching the DMARC gate — no code deploy needed to hold or resume the path.
  //
  // Fix pass 5, F-B (`docs/reviews/critic-report.md`): default flipped `true` -> `false`.
  // A kill switch that defaults ON is not a kill switch — it is a feature flag nobody
  // remembered to check, and this exact gap left a forgeable auth path wide open on any
  // deploy that copied `.env.example` and never explicitly set this var. Spike 3
  // (`docs/runbooks/live-spikes.md`) flips it back on once a live payload confirms the
  // field-name guess above.
  INBOUND_REQUESTS_ENABLED: boolFromEnv(false),
  // F-10: caps the inbound webhook's body before Fastify (and, for multipart, busboy)
  // parses any of it — sized just above Mailgun's documented payload ceiling.
  WEBHOOK_BODY_LIMIT_BYTES: intFromEnv(2 * 1024 * 1024, { min: 1 }),

  // --- Worker ---
  WORKER_ENABLED: boolFromEnv(true),
  WORKER_CONCURRENCY: intFromEnv(4, { min: 1 }),
  JOB_MAX_ATTEMPTS: intFromEnv(8, { min: 1 }),
});

/**
 * Fix pass 5, F-B (`docs/reviews/critic-report.md`): `MAILGUN_AUTHSERV_ID` has no schema
 * default (see its own field comment) — that is fine for a config that never actually
 * reads inbound mail, but silently letting it stay unset wherever it DOES matter is
 * exactly how the old `INBOUND_DOMAIN` fallback got shipped. Required whenever this
 * config could plausibly process live inbound webhooks: a real Mailgun adapter
 * (`ADAPTERS=real`), or the inbound path enabled in production. Cross-field, so it lives
 * in a `superRefine` rather than the object schema itself.
 *
 * Fix pass 6 (N-8, corrected premise): the reason `INBOUND_DOMAIN` must never be the
 * fallback is NOT that an authserv-id needs to be secret — no authserv-id is a secret,
 * it is the receiving mail server's own public hostname (`run-and-deploy.md` item 4a).
 * It is that `INBOUND_DOMAIN` is a DIFFERENT value entirely — our own domain, never
 * Mailgun's MX hostname — so it would never match a genuine stamp at all: the gate would
 * silently fail closed for the wrong reason, and flipping `INBOUND_AUTH_SOURCE=
 * authentication-results` would look broken (every genuine message quarantined) instead
 * of working.
 */
export const configSchema = baseConfigSchema.superRefine((val, ctx) => {
  const authservIdMatters =
    val.ADAPTERS === 'real' || (val.INBOUND_REQUESTS_ENABLED && val.NODE_ENV === 'production');
  if (authservIdMatters && !val.MAILGUN_AUTHSERV_ID) {
    ctx.addIssue({
      code: 'custom',
      path: ['MAILGUN_AUTHSERV_ID'],
      message:
        'MAILGUN_AUTHSERV_ID is required when ADAPTERS=real or when INBOUND_REQUESTS_ENABLED ' +
        'is true in production — it must never fall back to INBOUND_DOMAIN (a different, ' +
        "public value: OUR domain, not Mailgun's own MX hostname, so it would never match " +
        'a genuine stamp).',
    });
  }
});

export type Env = z.infer<typeof baseConfigSchema>;

export type Config = Omit<Env, 'COOKIE_SECURE'> & {
  COOKIE_SECURE: boolean;
};

/**
 * Parses `env` (normally `process.env`) into a validated, defaulted `Config`.
 * Throws a single `Error` with a readable, multi-line message on any invalid or
 * missing value — never a partial/undefined config.
 */
export function loadConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `  - ${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const parsed = result.data;
  const cookieSecure = parsed.COOKIE_SECURE ?? parsed.NODE_ENV !== 'development';
  return { ...parsed, COOKIE_SECURE: cookieSecure };
}

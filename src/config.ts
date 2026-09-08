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

export const configSchema = z.object({
  // --- Core ---
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: intFromEnv(3000, { min: 1 }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PUBLIC_BASE_URL: z.string().url({ message: 'PUBLIC_BASE_URL must be an absolute URL' }),
  INBOUND_DOMAIN: z.string().min(1, 'INBOUND_DOMAIN is required'),

  // --- Database ---
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PGPOOL_MAX: intFromEnv(10, { min: 1 }),

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
  MAX_UPLOAD_BYTES: intFromEnv(1_073_741_824, { min: 1 }),

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

  // --- Inbound retention ---
  RAW_PAYLOAD_RETENTION_DAYS: intFromEnv(7, { min: 0 }),

  // --- Google ---
  GOOGLE_CREDENTIAL_MODE: z.enum(['service_account', 'oauth_refresh']).default('service_account'),
  GOOGLE_SA_JSON_PATH: z.string().optional(),
  GOOGLE_IMPERSONATE_SUBJECT: z.string().optional(),
  GOOGLE_SHARED_DRIVE_ID: z.string().optional(),
  GOOGLE_ROOT_FOLDER_ID: z.string().optional(),

  // --- Zoho ---
  ZOHO_CLIENT_ID: z.string().optional(),
  ZOHO_CLIENT_SECRET: z.string().optional(),
  ZOHO_REFRESH_TOKEN: z.string().optional(),
  ZOHO_API_BASE: z.string().optional(),
  ZOHO_TEAM_FOLDER_ID: z.string().optional(),

  // --- Mailgun ---
  MAILGUN_API_BASE: z.string().optional(),
  MAILGUN_API_KEY: z.string().optional(),
  MAILGUN_SIGNING_KEY: z.string().optional(),
  MAILGUN_SENDING_DOMAIN: z.string().optional(),
  OUTBOUND_FROM: z.string().optional(),

  // --- Worker ---
  WORKER_ENABLED: boolFromEnv(true),
  WORKER_CONCURRENCY: intFromEnv(4, { min: 1 }),
  JOB_MAX_ATTEMPTS: intFromEnv(8, { min: 1 }),
});

export type Env = z.infer<typeof configSchema>;

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

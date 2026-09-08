import type { Pool } from './db/pool.js';
import type { Config } from './config.js';
import type { FileStorePort } from './ports/file-store.js';
import type { DriveSharePort } from './ports/drive-share.js';
import type { InboundMailPort } from './ports/inbound-mail.js';
import type { OutboundMailPort } from './ports/outbound-mail.js';
import type { BlobStagingPort } from './ports/blob-staging.js';
import type { Clock } from './ports/clock.js';
import type { TokenGen } from './ports/token-gen.js';

import { FakeFileStore } from './adapters/zoho/fake.js';
import { ZohoFileStore } from './adapters/zoho/real.js';
import { FakeDriveShare } from './adapters/google/fake.js';
import { GoogleDriveShare } from './adapters/google/real.js';
import { FakeInboundMail, FakeOutboundMail } from './adapters/mailgun/fake.js';
import { MailgunInboundAdapter, MailgunOutboundAdapter } from './adapters/mailgun/real.js';
import { LocalDiskBlobStaging } from './adapters/staging/real.js';
import { SystemClock, CryptoTokenGen } from './adapters/system/real.js';

import { AuthService } from './domain/auth.js';
import { FilesService } from './domain/files.js';
import { LinksService } from './domain/links.js';
import { SettingsService } from './domain/settings.js';
import { RequestPipeline } from './domain/request-pipeline.js';
import { SharingEngine } from './domain/sharing-engine.js';
import { AuditService } from './domain/audit.js';
import { RateLimitService } from './domain/rate-limit.js';
import { HealthService } from './domain/health.js';

export interface Ports {
  fileStore: FileStorePort;
  driveShare: DriveSharePort;
  inboundMail: InboundMailPort;
  outboundMail: OutboundMailPort;
  blobStaging: BlobStagingPort;
  clock: Clock;
  tokenGen: TokenGen;
}

export interface Services {
  auth: AuthService;
  files: FilesService;
  links: LinksService;
  settings: SettingsService;
  requestPipeline: RequestPipeline;
  sharingEngine: SharingEngine;
  audit: AuditService;
  rateLimit: RateLimitService;
  health: HealthService;
}

export interface Container {
  config: Config;
  pool: Pool;
  ports: Ports;
  services: Services;
}

type OverridableAdapter = 'zoho' | 'drive' | 'mailgun';
const OVERRIDABLE_ADAPTERS: readonly OverridableAdapter[] = ['zoho', 'drive', 'mailgun'];

/**
 * Parses `ADAPTER_OVERRIDES` (architecture.md §9), e.g. `"drive=fake,zoho=real"`, into a
 * per-adapter mode map. Fails fast on an unrecognized key or value — this is a dev-only
 * knob, so a typo should be loud, not silently ignored.
 */
function parseAdapterOverrides(
  raw: string | undefined,
): Partial<Record<OverridableAdapter, 'fake' | 'real'>> {
  if (!raw || raw.trim() === '') return {};
  const result: Partial<Record<OverridableAdapter, 'fake' | 'real'>> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (trimmed === '') continue;
    const [key, value] = trimmed.split('=').map((s) => s.trim());
    if (!key || !value) {
      throw new Error(
        `Invalid ADAPTER_OVERRIDES entry ${JSON.stringify(trimmed)} — expected "key=fake|real"`,
      );
    }
    if (!OVERRIDABLE_ADAPTERS.includes(key as OverridableAdapter)) {
      throw new Error(
        `Invalid ADAPTER_OVERRIDES key ${JSON.stringify(key)} — must be one of ${OVERRIDABLE_ADAPTERS.join(', ')}`,
      );
    }
    if (value !== 'fake' && value !== 'real') {
      throw new Error(
        `Invalid ADAPTER_OVERRIDES value ${JSON.stringify(value)} for ${key} — must be fake|real`,
      );
    }
    result[key as OverridableAdapter] = value;
  }
  return result;
}

function resolveMode(
  base: 'fake' | 'real',
  overrides: Partial<Record<OverridableAdapter, 'fake' | 'real'>>,
  name: OverridableAdapter,
): 'fake' | 'real' {
  return overrides[name] ?? base;
}

export interface BuildContainerOptions {
  config: Config;
  pool: Pool;
  /** Test-only escape hatch: substitute a specific port instance (e.g. a `FakeClock` with
   * virtual time) after the normal ADAPTERS-driven construction. Never used by `server.ts`. */
  overrides?: Partial<Ports>;
}

/**
 * Builds the full dependency graph — ports (per `ADAPTERS`/`ADAPTER_OVERRIDES`) and the
 * domain services that consume them (architecture.md §9, §11). Hard-refuses to boot with
 * any fake adapter selected while `NODE_ENV=production` (architecture.md §9) — this is the
 * one runtime invariant this file exists to enforce; get it wrong and a demo config could
 * ship live traffic through adapters that throw on every call.
 */
export function buildContainer({ config, pool, overrides }: BuildContainerOptions): Container {
  const adapterOverrides = parseAdapterOverrides(config.ADAPTER_OVERRIDES);
  const modes = {
    zoho: resolveMode(config.ADAPTERS, adapterOverrides, 'zoho'),
    drive: resolveMode(config.ADAPTERS, adapterOverrides, 'drive'),
    mailgun: resolveMode(config.ADAPTERS, adapterOverrides, 'mailgun'),
  };

  if (config.NODE_ENV === 'production') {
    const fakeAdapters = (Object.entries(modes) as [OverridableAdapter, 'fake' | 'real'][])
      .filter(([, mode]) => mode === 'fake')
      .map(([name]) => name);
    if (fakeAdapters.length > 0) {
      throw new Error(
        `Refusing to boot with fake adapter(s) [${fakeAdapters.join(', ')}] while NODE_ENV=production. ` +
          'Set ADAPTERS=real (and remove any fake entries from ADAPTER_OVERRIDES) before deploying.',
      );
    }
  }

  const clock: Clock = overrides?.clock ?? new SystemClock();
  const tokenGen: TokenGen = overrides?.tokenGen ?? new CryptoTokenGen();

  const fileStore: FileStorePort =
    overrides?.fileStore ??
    (modes.zoho === 'fake'
      ? new FakeFileStore()
      : new ZohoFileStore({
          apiBase: config.ZOHO_API_BASE ?? '',
          clientId: config.ZOHO_CLIENT_ID ?? '',
          clientSecret: config.ZOHO_CLIENT_SECRET ?? '',
          refreshToken: config.ZOHO_REFRESH_TOKEN ?? '',
          teamFolderId: config.ZOHO_TEAM_FOLDER_ID ?? '',
          accountsBase: config.ZOHO_ACCOUNTS_BASE,
          linkRoleId: config.ZOHO_LINK_ROLE_ID,
        }));

  const driveShare: DriveSharePort =
    overrides?.driveShare ??
    (modes.drive === 'fake'
      ? new FakeDriveShare()
      : new GoogleDriveShare({
          credentialMode: config.GOOGLE_CREDENTIAL_MODE,
          saJsonPath: config.GOOGLE_SA_JSON_PATH,
          impersonateSubject: config.GOOGLE_IMPERSONATE_SUBJECT,
          sharedDriveId: config.GOOGLE_SHARED_DRIVE_ID,
          rootFolderId: config.GOOGLE_ROOT_FOLDER_ID,
          oauthClientId: config.GOOGLE_OAUTH_CLIENT_ID,
          oauthClientSecret: config.GOOGLE_OAUTH_CLIENT_SECRET,
          oauthRefreshToken: config.GOOGLE_OAUTH_REFRESH_TOKEN,
        }));

  const mailgunConfig = {
    apiBase: config.MAILGUN_API_BASE ?? '',
    apiKey: config.MAILGUN_API_KEY ?? '',
    signingKey: config.MAILGUN_SIGNING_KEY ?? '',
    sendingDomain: config.MAILGUN_SENDING_DOMAIN ?? '',
    outboundFrom: config.OUTBOUND_FROM ?? '',
  };
  // F-1: `MAILGUN_AUTHSERV_ID` has no fixed schema default — falling back to
  // `INBOUND_DOMAIN` here (not in config.ts) keeps that fallback visible as a deliberate,
  // documented guess rather than a silent schema default; `mapping.ts`'s doc comment and
  // docs/runbooks/live-spikes.md spike #3 explain why it's still `@unverified-live`.
  const mailgunMappingConfig = {
    authservId: config.MAILGUN_AUTHSERV_ID ?? config.INBOUND_DOMAIN,
    authSource: config.INBOUND_AUTH_SOURCE,
  };
  const inboundMail: InboundMailPort =
    overrides?.inboundMail ??
    (modes.mailgun === 'fake'
      ? new FakeInboundMail(
          mailgunConfig.signingKey || 'dev-signing-key',
          clock,
          mailgunMappingConfig,
        )
      : new MailgunInboundAdapter(mailgunConfig, clock, mailgunMappingConfig));
  const outboundMail: OutboundMailPort =
    overrides?.outboundMail ??
    (modes.mailgun === 'fake' ? new FakeOutboundMail() : new MailgunOutboundAdapter(mailgunConfig));

  const blobStaging: BlobStagingPort =
    overrides?.blobStaging ?? new LocalDiskBlobStaging(config.STAGING_DIR);

  const ports: Ports = {
    fileStore,
    driveShare,
    inboundMail,
    outboundMail,
    blobStaging,
    clock,
    tokenGen,
  };

  const settings = new SettingsService(pool, { DEFAULT_EXPIRY_DAYS: config.DEFAULT_EXPIRY_DAYS });
  const rateLimit = new RateLimitService(pool, {
    RATE_REQUESTER_PER_HOUR: config.RATE_REQUESTER_PER_HOUR,
    RATE_FILE_PER_HOUR: config.RATE_FILE_PER_HOUR,
    RATE_TENANT_PER_HOUR: config.RATE_TENANT_PER_HOUR,
    RATE_DOMAIN_PER_HOUR: config.RATE_DOMAIN_PER_HOUR,
  });

  const services: Services = {
    auth: new AuthService(
      pool,
      { tokenGen, clock, outboundMail },
      {
        PUBLIC_BASE_URL: config.PUBLIC_BASE_URL,
        RATE_MAGICLINK_PER_HOUR: config.RATE_MAGICLINK_PER_HOUR,
      },
    ),
    files: new FilesService(
      pool,
      { fileStore, driveShare, blobStaging, tokenGen, clock },
      {
        MAX_UPLOAD_BYTES: config.MAX_UPLOAD_BYTES,
        DEFAULT_EXPIRY_DAYS: config.DEFAULT_EXPIRY_DAYS,
      },
      settings,
    ),
    links: new LinksService({
      BRANDED_PAGE_ENABLED: config.BRANDED_PAGE_ENABLED,
      PUBLIC_BASE_URL: config.PUBLIC_BASE_URL,
      INBOUND_DOMAIN: config.INBOUND_DOMAIN,
    }),
    settings,
    requestPipeline: new RequestPipeline(pool, { inboundMail, clock }, rateLimit, {
      INBOUND_DOMAIN: config.INBOUND_DOMAIN,
      RAW_PAYLOAD_RETENTION_DAYS: config.RAW_PAYLOAD_RETENTION_DAYS,
      INBOUND_REQUESTS_ENABLED: config.INBOUND_REQUESTS_ENABLED,
      QUARANTINE_PER_TOKEN_PER_HOUR: config.QUARANTINE_PER_TOKEN_PER_HOUR,
    }),
    sharingEngine: new SharingEngine(pool, driveShare, clock, {
      DRIVE_SHARE_SOFT_CAP: config.DRIVE_SHARE_SOFT_CAP,
      SHARE_PACE_MIN_INTERVAL_MS: config.SHARE_PACE_MIN_INTERVAL_MS,
    }),
    audit: new AuditService(pool),
    rateLimit,
    health: new HealthService(pool),
  };

  return { config, pool, ports, services };
}

import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { testPool } from './db.js';
import { loadConfig, type Config } from '../../src/config.js';
import { buildContainer, type Container } from '../../src/container.js';
import { FakeFileStore } from '../../src/adapters/zoho/fake.js';
import { FakeDriveShare } from '../../src/adapters/google/fake.js';
import { FakeInboundMail, FakeOutboundMail } from '../../src/adapters/mailgun/fake.js';
import { FakeClock } from '../../src/adapters/system/fake.js';
import { CryptoTokenGen } from '../../src/adapters/system/real.js';
import { LocalDiskBlobStaging } from '../../src/adapters/staging/real.js';

/** Known to every test that needs to mint a valid Mailgun-style webhook signature. */
export const TEST_SIGNING_KEY = 'test-signing-key-do-not-use-in-prod';

export interface TestContainer extends Container {
  fakes: {
    fileStore: FakeFileStore;
    driveShare: FakeDriveShare;
    inboundMail: FakeInboundMail;
    outboundMail: FakeOutboundMail;
    clock: FakeClock;
  };
}

/** A fully-valid `Config`, sane for tests, overridable per test. `DATABASE_URL` is a
 * required field but never actually connected through here — tests always pass the real
 * `testPool()` in directly. */
export function buildTestConfig(overrides: Partial<Config> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PUBLIC_BASE_URL: 'https://app.test.swenlly.example',
    INBOUND_DOMAIN: 'share.swenlly.test',
    DATABASE_URL: 'postgres://unused/unused',
    SESSION_SECRET: 'a'.repeat(32),
    STAGING_DIR: mkdtempSync(path.join(os.tmpdir(), 'swenlly-staging-')),
    MAILGUN_SIGNING_KEY: TEST_SIGNING_KEY,
    ADAPTERS: 'fake',
    ...overrides,
  } as Record<string, string>);
}

/** Builds a full `Container` against real Postgres (`testPool()` by default) wired to
 * semantic fakes for every external port, and hands back the concrete fake instances
 * (not just their port types) so tests can arm/inspect them (e.g.
 * `container.fakes.driveShare.setQuotaPerFile(5)`). */
export function buildTestContainer(
  configOverrides: Partial<Config> = {},
  pool: pg.Pool = testPool(),
): TestContainer {
  const config = buildTestConfig(configOverrides);
  const clock = new FakeClock();
  const fileStore = new FakeFileStore();
  const driveShare = new FakeDriveShare();
  const inboundMail = new FakeInboundMail(config.MAILGUN_SIGNING_KEY ?? TEST_SIGNING_KEY, clock);
  const outboundMail = new FakeOutboundMail();
  const blobStaging = new LocalDiskBlobStaging(config.STAGING_DIR);

  const container = buildContainer({
    config,
    pool,
    overrides: {
      clock,
      tokenGen: new CryptoTokenGen(),
      fileStore,
      driveShare,
      inboundMail,
      outboundMail,
      blobStaging,
    },
  });

  return { ...container, fakes: { fileStore, driveShare, inboundMail, outboundMail, clock } };
}

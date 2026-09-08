import { describe, expect, it } from 'vitest';
import { hasTestDatabase, testPool } from '../setup/db.js';
import { loadConfig } from '../../src/config.js';
import { buildContainer } from '../../src/container.js';

const REQUIRED_ENV = {
  PUBLIC_BASE_URL: 'https://app.example.com',
  INBOUND_DOMAIN: 'share.example.com',
  DATABASE_URL: 'postgres://unused/unused',
  SESSION_SECRET: 'x'.repeat(32),
};

describe.skipIf(!hasTestDatabase())('production refuses fake adapters (architecture.md §9)', () => {
  it('throws at boot if ADAPTERS=fake and NODE_ENV=production', () => {
    const config = loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'production', ADAPTERS: 'fake' });
    expect(() => buildContainer({ config, pool: testPool() })).toThrow(/production/);
  });

  it('throws if ADAPTER_OVERRIDES puts even one adapter on fake in production, despite ADAPTERS=real', () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      ADAPTERS: 'real',
      ADAPTER_OVERRIDES: 'drive=fake',
    });
    expect(() => buildContainer({ config, pool: testPool() })).toThrow(/drive/);
  });

  it('does NOT throw with ADAPTERS=real and no fake overrides in production', () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      ADAPTERS: 'real',
    });
    expect(() => buildContainer({ config, pool: testPool() })).not.toThrow();
  });

  it('ADAPTERS=fake is fine outside production (development, test)', () => {
    for (const NODE_ENV of ['development', 'test'] as const) {
      const config = loadConfig({ ...REQUIRED_ENV, NODE_ENV, ADAPTERS: 'fake' });
      expect(() => buildContainer({ config, pool: testPool() })).not.toThrow();
    }
  });

  it('rejects an unrecognized ADAPTER_OVERRIDES key or value', () => {
    const badKey = loadConfig({ ...REQUIRED_ENV, ADAPTER_OVERRIDES: 'bogus=fake' });
    expect(() => buildContainer({ config: badKey, pool: testPool() })).toThrow(/ADAPTER_OVERRIDES/);

    const badValue = loadConfig({ ...REQUIRED_ENV, ADAPTER_OVERRIDES: 'drive=maybe' });
    expect(() => buildContainer({ config: badValue, pool: testPool() })).toThrow(
      /ADAPTER_OVERRIDES/,
    );
  });
});

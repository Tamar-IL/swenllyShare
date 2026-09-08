import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

const REQUIRED_ENV = {
  PUBLIC_BASE_URL: 'http://localhost:3000',
  INBOUND_DOMAIN: 'share.swenlly.com',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults for everything not required', () => {
    const config = loadConfig(REQUIRED_ENV);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('info');
    expect(config.PGPOOL_MAX).toBe(10);
    expect(config.ADAPTERS).toBe('fake');
    expect(config.BRANDED_PAGE_ENABLED).toBe(false);
    expect(config.ATTACH_LIMIT_BYTES).toBe(20_971_520);
    expect(config.MAX_UPLOAD_BYTES).toBe(1_073_741_824);
    expect(config.STAGING_RETENTION_HOURS).toBe(24);
    expect(config.DRIVE_SHARE_SOFT_CAP).toBe(500);
    expect(config.SHARE_PACE_MIN_INTERVAL_MS).toBe(1500);
    expect(config.DEFAULT_EXPIRY_DAYS).toBe(30);
    expect(config.RATE_REQUESTER_PER_HOUR).toBe(5);
    expect(config.RATE_FILE_PER_HOUR).toBe(60);
    expect(config.RATE_TENANT_PER_HOUR).toBe(300);
    expect(config.RATE_MAGICLINK_PER_HOUR).toBe(5);
    expect(config.RAW_PAYLOAD_RETENTION_DAYS).toBe(7);
    expect(config.GOOGLE_CREDENTIAL_MODE).toBe('service_account');
    expect(config.WORKER_ENABLED).toBe(true);
    expect(config.WORKER_CONCURRENCY).toBe(4);
    expect(config.JOB_MAX_ATTEMPTS).toBe(8);
    // F-1/F-7/F-8/F-10 (red-team fixes) — see docs/security/red-team-report.md.
    expect(config.RATE_DOMAIN_PER_HOUR).toBe(30);
    expect(config.QUARANTINE_PER_TOKEN_PER_HOUR).toBe(5);
    expect(config.INBOUND_AUTH_SOURCE).toBe('both');
    expect(config.INBOUND_REQUESTS_ENABLED).toBe(true);
    expect(config.WEBHOOK_BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024);
    expect(config.MAILGUN_AUTHSERV_ID).toBeUndefined();
  });

  it('F-1: INBOUND_REQUESTS_ENABLED and INBOUND_AUTH_SOURCE parse from env', () => {
    const config = loadConfig({
      ...REQUIRED_ENV,
      INBOUND_REQUESTS_ENABLED: 'false',
      INBOUND_AUTH_SOURCE: 'mailgun-fields',
      MAILGUN_AUTHSERV_ID: 'mx.example.test',
    });
    expect(config.INBOUND_REQUESTS_ENABLED).toBe(false);
    expect(config.INBOUND_AUTH_SOURCE).toBe('mailgun-fields');
    expect(config.MAILGUN_AUTHSERV_ID).toBe('mx.example.test');
  });

  it('throws a readable, multi-issue message when required vars are missing', () => {
    expect(() => loadConfig({})).toThrowError(/Invalid configuration/);
    try {
      loadConfig({});
      expect.unreachable();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('PUBLIC_BASE_URL');
      expect(message).toContain('INBOUND_DOMAIN');
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('SESSION_SECRET');
    }
  });

  it('rejects a SESSION_SECRET shorter than 32 characters', () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, SESSION_SECRET: 'short' })).toThrowError(
      /SESSION_SECRET/,
    );
  });

  it('rejects a non-absolute PUBLIC_BASE_URL', () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, PUBLIC_BASE_URL: 'not-a-url' })).toThrowError();
  });

  it('defaults COOKIE_SECURE to false only in development, true otherwise', () => {
    expect(loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'development' }).COOKIE_SECURE).toBe(false);
    expect(loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'production' }).COOKIE_SECURE).toBe(true);
    expect(loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'test' }).COOKIE_SECURE).toBe(true);
  });

  it('lets COOKIE_SECURE be set explicitly regardless of NODE_ENV', () => {
    expect(
      loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'production', COOKIE_SECURE: 'false' }).COOKIE_SECURE,
    ).toBe(false);
  });

  it('parses boolean env vars correctly, including the literal string "false"', () => {
    // Regression: z.coerce.boolean() treats any non-empty string, including "false",
    // as truthy — this must not be that.
    expect(
      loadConfig({ ...REQUIRED_ENV, BRANDED_PAGE_ENABLED: 'false' }).BRANDED_PAGE_ENABLED,
    ).toBe(false);
    expect(loadConfig({ ...REQUIRED_ENV, BRANDED_PAGE_ENABLED: 'true' }).BRANDED_PAGE_ENABLED).toBe(
      true,
    );
    expect(loadConfig({ ...REQUIRED_ENV, WORKER_ENABLED: 'false' }).WORKER_ENABLED).toBe(false);
  });

  it('coerces numeric env vars from strings', () => {
    const config = loadConfig({ ...REQUIRED_ENV, PORT: '8080', RATE_FILE_PER_HOUR: '120' });
    expect(config.PORT).toBe(8080);
    expect(config.RATE_FILE_PER_HOUR).toBe(120);
  });

  it('rejects an out-of-enum NODE_ENV', () => {
    expect(() => loadConfig({ ...REQUIRED_ENV, NODE_ENV: 'staging' })).toThrowError();
  });
});

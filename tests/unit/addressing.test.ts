import { describe, expect, it } from 'vitest';
import { buildRequestAddress, parseRequestAddress } from '../../src/lib/addressing.js';
import { opaqueTokenExact } from '../../src/lib/base32.js';

const DOMAIN = 'share.swenlly.test';

describe('addressing', () => {
  it('buildRequestAddress emits the "+" form, lowercased', () => {
    const addr = buildRequestAddress('MySlug1', 'ABC'.repeat(9).slice(0, 26), DOMAIN);
    expect(addr).toBe(`cust-myslug1+file-${'abc'.repeat(9).slice(0, 26)}@${DOMAIN}`);
  });

  it('parseRequestAddress accepts the emitted "+" form and round-trips slug/token', () => {
    const slug = 'tenant01';
    const token = opaqueTokenExact(130);
    expect(token).toHaveLength(26);
    const addr = buildRequestAddress(slug, token, DOMAIN);

    const parsed = parseRequestAddress(addr, DOMAIN);
    expect(parsed).toEqual({ slug, token });
  });

  it('parseRequestAddress accepts the "--" separator with identical effect to "+"', () => {
    const slug = 'tenant02';
    const token = opaqueTokenExact(130);
    const plusAddr = buildRequestAddress(slug, token, DOMAIN);
    const dashAddr = plusAddr.replace('+file-', '--file-');

    expect(parseRequestAddress(dashAddr, DOMAIN)).toEqual({ slug, token });
  });

  it('is case-insensitive on input', () => {
    const slug = 'tenant03';
    const token = opaqueTokenExact(130);
    const addr = buildRequestAddress(slug, token, DOMAIN).toUpperCase();
    expect(parseRequestAddress(addr, DOMAIN)).toEqual({ slug, token });
  });

  it('rejects a slug shorter than 6 or longer than 32 characters', () => {
    const token = opaqueTokenExact(130);
    expect(parseRequestAddress(`cust-ab+file-${token}@${DOMAIN}`, DOMAIN)).toBeNull();
    const longSlug = 'a'.repeat(33);
    expect(parseRequestAddress(`cust-${longSlug}+file-${token}@${DOMAIN}`, DOMAIN)).toBeNull();
  });

  it('rejects a token that is not exactly 26 characters', () => {
    expect(parseRequestAddress(`cust-tenant01+file-short@${DOMAIN}`, DOMAIN)).toBeNull();
  });

  it('rejects a domain that does not exactly match expectedDomain', () => {
    const token = opaqueTokenExact(130);
    const addr = buildRequestAddress('tenant04', token, 'evil.example');
    expect(parseRequestAddress(addr, DOMAIN)).toBeNull();
  });

  it('rejects garbage input entirely', () => {
    expect(parseRequestAddress('not-an-address-at-all', DOMAIN)).toBeNull();
    expect(parseRequestAddress('', DOMAIN)).toBeNull();
  });
});

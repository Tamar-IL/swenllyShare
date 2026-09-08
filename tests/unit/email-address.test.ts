import { describe, expect, it } from 'vitest';
import {
  addressDomain,
  parseMailboxList,
  parseSingleMailbox,
} from '../../src/lib/email-address.js';

/**
 * Unit coverage for `src/lib/email-address.ts` (F-3, `docs/security/red-team-report.md`).
 * The integration-level security properties this parser exists for (RT-04's two-`@`
 * bypass, the display-name-spoof/multi-address rejections) are already pinned end-to-end
 * in `tests/redteam/auth-gate-bypass.test.ts` — these tests are the parser's own
 * unit-level contract, independent of the pipeline around it.
 */
describe('parseSingleMailbox / parseMailboxList', () => {
  it('parses a bare address', () => {
    expect(parseSingleMailbox('sender@example.com')).toEqual({
      address: 'sender@example.com',
      domain: 'example.com',
    });
  });

  it('parses "Display Name" <addr> and bare Display Name <addr> forms', () => {
    expect(parseSingleMailbox('"Some Sender" <sender@example.com>')).toEqual({
      address: 'sender@example.com',
      domain: 'example.com',
    });
    expect(parseSingleMailbox('Sender Name <sender@example.com>')).toEqual({
      address: 'sender@example.com',
      domain: 'example.com',
    });
  });

  it('lowercases the local part and ASCII-normalizes/lowercases an IDN domain', () => {
    expect(parseSingleMailbox('Attacker@RELAY.test')).toEqual({
      address: 'attacker@relay.test',
      domain: 'relay.test',
    });
    const parsed = parseSingleMailbox('user@пример.рф');
    expect(parsed?.domain).toMatch(/^xn--/);
  });

  it('trims surrounding whitespace', () => {
    expect(parseSingleMailbox('  <Attacker@RELAY.test>  ')).toEqual({
      address: 'attacker@relay.test',
      domain: 'relay.test',
    });
  });

  it('F-3/RT-04: rejects an addr-spec with two `@` rather than picking one', () => {
    expect(parseSingleMailbox('victim@corp.test@attacker.test')).toBeNull();
    expect(parseSingleMailbox('<victim@corp.test@attacker.test>')).toBeNull();
  });

  it('rejects zero `@` (not an address at all)', () => {
    expect(parseSingleMailbox('not-an-address')).toBeNull();
  });

  it('rejects an empty local part or empty domain', () => {
    expect(parseSingleMailbox('@example.com')).toBeNull();
    expect(parseSingleMailbox('user@')).toBeNull();
  });

  it('parseMailboxList returns every mailbox in a comma-separated header, but parseSingleMailbox rejects it', () => {
    // gate 6 (architecture.md §4.6) needs exactly one — `parseSingleMailbox` is the
    // strict wrapper the pipeline actually uses; `parseMailboxList` itself just parses.
    expect(parseMailboxList('<victim@x.test>, <attacker@y.test>')).toEqual([
      { address: 'victim@x.test', domain: 'x.test' },
      { address: 'attacker@y.test', domain: 'y.test' },
    ]);
    expect(parseSingleMailbox('<victim@x.test>, <attacker@y.test>')).toBeNull();
  });

  it('a quoted display name containing a comma does not split into two mailboxes', () => {
    expect(parseSingleMailbox('"Doe, John" <john@example.com>')).toEqual({
      address: 'john@example.com',
      domain: 'example.com',
    });
  });

  it('deliberately rejects a display name that itself looks like an address (spoof guard)', () => {
    // See src/lib/email-address.ts's ADDRESS_LOOKING_RE comment: this is a stricter-than-
    // RFC-5322 choice pinned by the red team's own "display-name spoof" regression.
    expect(parseSingleMailbox('"victim@corp.test" <attacker@relay.test>')).toBeNull();
  });

  it('rejects an unbalanced angle bracket', () => {
    expect(parseSingleMailbox('<attacker@relay.test')).toBeNull();
  });

  it('rejects embedded control characters', () => {
    expect(parseSingleMailbox('attacker@relay.test\r\nX-Injected: yes')).toBeNull();
  });

  it('rejects a quoted local-part (legal RFC 5322, deliberately unsupported here)', () => {
    expect(parseSingleMailbox('"john doe"@example.com')).toBeNull();
  });
});

describe('addressDomain', () => {
  it('returns the domain after the LAST @ (matches how SMTP routes, not the first)', () => {
    expect(addressDomain('victim@corp.test@attacker.test')).toBe('attacker.test');
    expect(addressDomain('user@example.com')).toBe('example.com');
  });

  it('returns an empty string for an address with no @', () => {
    expect(addressDomain('not-an-address')).toBe('');
  });
});

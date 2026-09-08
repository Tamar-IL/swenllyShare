import { describe, expect, it } from 'vitest';
import {
  mapMailgunInboundPayload,
  type MailgunMappingConfig,
} from '../../src/adapters/mailgun/mapping.js';

/**
 * Unit coverage for the F-1 fix's PRIMARY path — parsing `Authentication-Results` out of
 * Mailgun's documented `message-headers` JSON array (`docs/security/red-team-report.md`).
 * The pinned red-team suite (`tests/redteam/auth-gate-bypass.test.ts`) never actually
 * populates `message-headers` in any of its payloads, so it only exercises the degraded
 * top-level-field fallback and the `mailgun-fields` source — this file closes that gap.
 */
const CONFIG: MailgunMappingConfig = { authservId: 'mx.example.test', authSource: 'both' };

describe('mapMailgunInboundPayload — Authentication-Results / message-headers', () => {
  it('reads dmarc/spf/dkim/dmarcDomain from a message-headers entry matching authservId', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'ceo@corp.test',
      token: 'tok-1',
      'message-headers': JSON.stringify([
        ['From', 'ceo@corp.test'],
        [
          'Authentication-Results',
          'mx.example.test; dmarc=pass header.from=corp.test; spf=pass smtp.mailfrom=corp.test; dkim=pass header.d=corp.test',
        ],
      ]),
    };
    const parsed = mapMailgunInboundPayload(payload, CONFIG);
    expect(parsed.dmarc).toBe('pass');
    expect(parsed.spf).toBe('pass');
    expect(parsed.dkim).toBe('pass');
    expect(parsed.dmarcDomain).toBe('corp.test');
  });

  it('accepts message-headers as an already-parsed array (not just a JSON string)', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'ceo@corp.test',
      token: 'tok-1',
      'message-headers': [
        ['Authentication-Results', 'mx.example.test; dmarc=pass header.from=corp.test'],
      ],
    };
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('pass');
  });

  it('takes the TOPMOST Authentication-Results entry whose authserv-id matches, skipping others', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'ceo@corp.test',
      token: 'tok-1',
      'message-headers': JSON.stringify([
        // A forged/unrelated Authentication-Results from a different hop — not ours.
        ['Authentication-Results', 'attacker-mx.evil.test; dmarc=pass header.from=corp.test'],
        // Ours — the receiving MTA's own, matching MAILGUN_AUTHSERV_ID.
        ['Authentication-Results', 'mx.example.test; dmarc=fail header.from=corp.test'],
      ]),
    };
    // Our own entry is what gets used, even though it's not literally first in the
    // array — the attacker-claimed authserv-id never matches and is skipped.
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('fail');
  });

  it('matches an authserv-id as a DNS suffix of the configured host (mxa.<host> vs <host>)', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'ceo@corp.test',
      token: 'tok-1',
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'mxa.mx.example.test; dmarc=pass header.from=corp.test'],
      ]),
    };
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('pass');
  });

  it('F-1: a mailgun-fields candidate duplicated in message-headers is NOT trusted', () => {
    // The attacker's own message literally carries a `Dmarc` (or similarly-named) header,
    // which Mailgun's flattening would put in message-headers — the dedup guard must
    // refuse to also trust a same-named top-level field in that case.
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'attacker@evil.test',
      token: 'tok-1',
      dmarc: 'pass', // attacker-controlled top-level field
      'message-headers': JSON.stringify([['dmarc', 'pass']]),
    };
    const parsed = mapMailgunInboundPayload(payload, {
      authservId: 'mx.example.test',
      authSource: 'mailgun-fields',
    });
    expect(parsed.dmarc).toBe('unknown');
  });

  it('mailgun-fields source still works when the field is NOT duplicated in message-headers', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'sender@corp.test',
      token: 'tok-1',
      dmarc: 'pass',
    };
    const parsed = mapMailgunInboundPayload(payload, {
      authservId: 'mx.example.test',
      authSource: 'mailgun-fields',
    });
    expect(parsed.dmarc).toBe('pass');
  });

  it('INBOUND_AUTH_SOURCE=authentication-results ignores mailgun-fields entirely', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'sender@corp.test',
      token: 'tok-1',
      dmarc: 'pass', // would be trusted under mailgun-fields/both, but not this source
    };
    const parsed = mapMailgunInboundPayload(payload, {
      authservId: 'mx.example.test',
      authSource: 'authentication-results',
    });
    expect(parsed.dmarc).toBe('unknown');
  });

  it('defaults to unknown, never infers pass, when nothing matches', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'sender@corp.test',
      token: 'tok-1',
    };
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('unknown');
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarcDomain).toBeNull();
  });
});

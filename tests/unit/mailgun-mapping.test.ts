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
      'message-headers': JSON.stringify([['From', 'sender@corp.test']]),
      dmarc: 'pass',
    };
    const parsed = mapMailgunInboundPayload(payload, {
      authservId: 'mx.example.test',
      authSource: 'mailgun-fields',
    });
    expect(parsed.dmarc).toBe('pass');
  });

  it('fix pass 5, F-B: mailgun-fields is trusted for NOTHING when message-headers is absent — pins attack B as blocked, not intended behaviour', () => {
    // This test used to assert dmarc === 'pass' here — i.e. it pinned the exact forgery
    // the critic's attack B demonstrates (an attacker's own top-level `dmarc: pass` +
    // `dmarc-domain:` fields, with no message-headers to prove they aren't just a copy of
    // the attacker's own MIME headers) as INTENDED behaviour. `docs/reviews/critic-
    // report.md` F-B: "It pins attack B as intended behaviour." Fixed: the anti-forgery
    // dedup guard is inoperative without message-headers, so the honest verdict is
    // `unknown`, full stop — regardless of INBOUND_AUTH_SOURCE.
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'attacker@evil.test',
      token: 'tok-1',
      dmarc: 'pass',
      'dmarc-domain': 'evil.test',
      // Deliberately no `message-headers` at all.
    };
    const parsed = mapMailgunInboundPayload(payload, {
      authservId: 'mx.example.test',
      authSource: 'mailgun-fields',
    });
    expect(parsed.dmarc).toBe('unknown');
    expect(parsed.dmarcDomain).toBeNull();
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

  /**
   * Fix pass 5, F-B re-check (`docs/reviews/critic-report.md`): the critic's own four
   * probe payloads, called directly against `mapMailgunInboundPayload` with a properly-
   * configured, non-public `authservId` (`docs/reviews/critic-report.md` used the OLD
   * `INBOUND_DOMAIN`-fallback value, `share.swenlly.com` — F-B fix item 4 removes that
   * fallback; `mxa.swenlly-mail.example` here stands in for a genuine, Mailgun-assigned
   * value an attacker cannot read off the product's own mailto links). A/B/C must now
   * quarantine as `unknown`; D — the one payload where the defense already held — must
   * still resolve `fail`, not regress to `unknown`.
   */
  describe('fix pass 5, F-B: the critic four probe payloads (A-D)', () => {
    const REAL_AUTHSERV_ID = 'mxa.swenlly-mail.example';
    const PROBE_CONFIG: MailgunMappingConfig = { authservId: REAL_AUTHSERV_ID, authSource: 'both' };
    const base = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'attacker@evil.test',
      token: 'tok-1',
    };

    it('A: no message-headers, attacker top-level Authentication-Results with a bogus authserv-id -> unknown', () => {
      const payload = {
        ...base,
        'Authentication-Results': 'totally-made-up.evil.test; dmarc=pass header.from=evil.test',
      };
      const parsed = mapMailgunInboundPayload(payload, PROBE_CONFIG);
      expect(parsed.dmarc).toBe('unknown');
    });

    it('B: no message-headers, attacker top-level dmarc/dmarc-domain fields -> unknown', () => {
      const payload = { ...base, dmarc: 'pass', 'dmarc-domain': 'evil.test' };
      const parsed = mapMailgunInboundPayload(payload, PROBE_CONFIG);
      expect(parsed.dmarc).toBe('unknown');
      expect(parsed.dmarcDomain).toBeNull();
    });

    it('C: message-headers present, Mailgun stamps nothing itself, attacker forges an Authentication-Results entry naming the (guessable) OLD public fallback authserv-id -> unknown', () => {
      const payload = {
        ...base,
        'message-headers': JSON.stringify([
          ['From', 'attacker@evil.test'],
          ['Subject', 'please send the file'],
          // The attacker's own forged trace header — names the value a public
          // `INBOUND_DOMAIN`-derived guess would have produced, NOT the real,
          // properly-configured `MAILGUN_AUTHSERV_ID` above.
          ['Authentication-Results', 'share.swenlly.test; dmarc=pass header.from=evil.test'],
        ]),
      };
      const parsed = mapMailgunInboundPayload(payload, PROBE_CONFIG);
      expect(parsed.dmarc).toBe('unknown');
    });

    it("D: message-headers present with a genuine dmarc=fail on top and the attacker's pass below -> fail (defense holds)", () => {
      const payload = {
        ...base,
        'message-headers': JSON.stringify([
          ['From', 'attacker@evil.test'],
          // Mailgun's own, genuine stamp — matches the real authserv-id, and (per
          // receipt order) sits ABOVE anything the original message itself carried.
          ['Authentication-Results', `${REAL_AUTHSERV_ID}; dmarc=fail header.from=evil.test`],
          // The attacker's own forged entry, further down — also names the real
          // authserv-id, but is correctly skipped: the TOPMOST match wins.
          ['Authentication-Results', `${REAL_AUTHSERV_ID}; dmarc=pass header.from=evil.test`],
        ]),
      };
      const parsed = mapMailgunInboundPayload(payload, PROBE_CONFIG);
      expect(parsed.dmarc).toBe('fail');
    });
  });
});

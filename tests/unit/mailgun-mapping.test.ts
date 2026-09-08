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
const CONFIG: MailgunMappingConfig = {
  authservId: 'mx.example.test',
  authSource: 'authentication-results',
};

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

  it('uses the single Authentication-Results entry naming our authserv-id, ignoring foreign ones', () => {
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
    // Our own entry is what gets used — the foreign authserv-id never matches and is
    // ignored, and since exactly ONE entry names ours there is no ambiguity.
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('fail');
  });

  it('fix pass 6 (critic C\u2033): a DNS-suffix authserv-id (mxa.<host>, evil.<host>) does NOT match', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'ceo@corp.test',
      token: 'tok-1',
      'message-headers': JSON.stringify([
        ['Authentication-Results', 'evil.mx.example.test; dmarc=pass header.from=corp.test'],
      ]),
    };
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('unknown');
  });

  it('fix pass 6 (critic F-B): TWO Authentication-Results naming our authserv-id is ambiguous -> unknown, whichever order', () => {
    const entries: [string, string][] = [
      ['Authentication-Results', 'mx.example.test; dmarc=pass header.from=corp.test'],
      ['Authentication-Results', 'mx.example.test; dmarc=fail header.from=corp.test'],
    ];
    for (const order of [entries, [...entries].reverse()]) {
      const payload = {
        recipient: 'cust-abc123+file-def456@share.swenlly.test',
        From: 'ceo@corp.test',
        token: 'tok-1',
        'message-headers': JSON.stringify(order),
      };
      expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('unknown');
    }
  });

  it('fix pass 6 (critic N-1): in authentication-results mode a colliding synthetic field name makes the verdict unknown, never a fallthrough', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'attacker@evil.test',
      token: 'tok-1',
      Dmarc: 'pass',
      'message-headers': JSON.stringify([
        ['Dmarc', 'pass'],
        ['Authentication-Results', 'mx.example.test; dmarc=pass header.from=evil.test'],
      ]),
    };
    expect(mapMailgunInboundPayload(payload, CONFIG).dmarc).toBe('unknown');
  });

  it('fix pass 6: the two sources disagreeing on DMARC -> unknown in either mode', () => {
    const payload = {
      recipient: 'cust-abc123+file-def456@share.swenlly.test',
      From: 'attacker@evil.test',
      token: 'tok-1',
      dmarc: 'fail',
      'dmarc-domain': 'evil.test',
      'message-headers': JSON.stringify([
        ['From', 'attacker@evil.test'],
        ['Authentication-Results', 'mx.example.test; dmarc=pass header.from=evil.test'],
      ]),
    };
    for (const authSource of ['mailgun-fields', 'authentication-results'] as const) {
      const parsed = mapMailgunInboundPayload(payload, {
        authservId: 'mx.example.test',
        authSource,
      });
      expect(parsed.dmarc).toBe('unknown');
    }
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
      dmarc: 'pass', // would be trusted under mailgun-fields, but not this source
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
    const PROBE_CONFIG: MailgunMappingConfig = {
      authservId: REAL_AUTHSERV_ID,
      authSource: 'authentication-results',
    };
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

    it("D: message-headers present with a genuine dmarc=fail on top and the attacker's pass below -> unknown (two entries name our authserv-id: ambiguous, quarantined either way)", () => {
      const payload = {
        ...base,
        'message-headers': JSON.stringify([
          ['From', 'attacker@evil.test'],
          ['Authentication-Results', `${REAL_AUTHSERV_ID}; dmarc=fail header.from=evil.test`],
          ['Authentication-Results', `${REAL_AUTHSERV_ID}; dmarc=pass header.from=evil.test`],
        ]),
      };
      // Fix pass 6: stricter than "topmost wins" — the presence of a second entry naming
      // our authserv-id is itself evidence of forgery, and the result must not depend on
      // whether the receiving MTA prepends or appends. Still a quarantine.
      const parsed = mapMailgunInboundPayload(payload, PROBE_CONFIG);
      expect(parsed.dmarc).toBe('unknown');
    });

    it('C\u2032: message-headers present, Mailgun stamps nothing, attacker forges ONE Authentication-Results naming the REAL authserv-id -> unknown in mailgun-fields mode (no synthetic field vouches for it)', () => {
      const payload = {
        ...base,
        'message-headers': JSON.stringify([
          ['From', 'attacker@evil.test'],
          ['Authentication-Results', `${REAL_AUTHSERV_ID}; dmarc=pass header.from=evil.test`],
        ]),
      };
      const parsed = mapMailgunInboundPayload(payload, {
        authservId: REAL_AUTHSERV_ID,
        authSource: 'mailgun-fields',
      });
      expect(parsed.dmarc).toBe('unknown');
      // Documented residual: in authentication-results mode this exact payload is
      // indistinguishable from a genuine single stamp. That mode is only permitted once
      // spike 3 proves Mailgun always stamps its own header (mapping.ts doc comment).
    });

    it('F: attacker adds a MIME header named `Dmarc:` -> the synthetic source is ambiguous -> unknown, never a fallthrough to a weaker source', () => {
      const payload = {
        ...base,
        dmarc: 'fail', // Mailgun's genuine synthetic verdict
        'dmarc-domain': 'evil.test',
        Dmarc: 'pass', // the attacker's MIME header, flattened
        'message-headers': JSON.stringify([
          ['From', 'attacker@evil.test'],
          ['Dmarc', 'pass'],
          ['Authentication-Results', `${REAL_AUTHSERV_ID}; dmarc=pass header.from=evil.test`],
        ]),
      };
      for (const authSource of ['mailgun-fields', 'authentication-results'] as const) {
        const parsed = mapMailgunInboundPayload(payload, {
          authservId: REAL_AUTHSERV_ID,
          authSource,
        });
        expect(parsed.dmarc).toBe('unknown');
      }
    });
  });
});

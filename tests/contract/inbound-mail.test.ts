import { beforeEach, describe, expect, it } from 'vitest';
import type { InboundMailPort } from '../../src/ports/inbound-mail.js';
import { FakeInboundMail, computeMailgunSignature } from '../../src/adapters/mailgun/fake.js';
import { MailgunInboundAdapter, type MailgunConfig } from '../../src/adapters/mailgun/real.js';
import { SystemClock } from '../../src/adapters/system/real.js';

/**
 * `InboundMailPort` contract suite, run against both adapters (architecture.md §2, §9 item
 * 4). Unlike Drive/Zoho, `verify`/`parse` make no network call, so the `real` leg could
 * technically run unconditionally — but it's gated behind `LIVE_MAILGUN=1` anyway for
 * consistency with the other two ports and because "real" here should mean "exercised
 * against this project's actual `MAILGUN_SIGNING_KEY`", not a fabricated test key.
 * Reports **skipped, not passed** without it. See `docs/runbooks/live-spikes.md` spike #3,
 * and `tests/contract/mailgun-wire.test.ts` for the always-on offline tests of the same
 * two methods.
 */

const LIVE = process.env.LIVE_MAILGUN === '1';

if (!LIVE) {
  console.warn(
    '\n[contract/inbound-mail] LIVE_MAILGUN is not set — the real InboundMailPort ' +
      'contract leg is SKIPPED, not passed. Set LIVE_MAILGUN=1 plus MAILGUN_SIGNING_KEY ' +
      'to run it for real (docs/runbooks/live-spikes.md spike #3).\n',
  );
}

const SIGNING_KEY = process.env.MAILGUN_SIGNING_KEY ?? 'contract-test-signing-key';

function buildReal(): InboundMailPort {
  const config: MailgunConfig = {
    apiBase: process.env.MAILGUN_API_BASE ?? '',
    apiKey: process.env.MAILGUN_API_KEY ?? '',
    signingKey: SIGNING_KEY,
    sendingDomain: process.env.MAILGUN_SENDING_DOMAIN ?? '',
    outboundFrom: process.env.OUTBOUND_FROM ?? '',
  };
  return new MailgunInboundAdapter(config, new SystemClock());
}

const scenarios: { name: string; skip: boolean; build: () => InboundMailPort }[] = [
  { name: 'fake', skip: false, build: () => new FakeInboundMail(SIGNING_KEY, new SystemClock()) },
  { name: 'real', skip: !LIVE, build: buildReal },
];

for (const scenario of scenarios) {
  describe.skipIf(scenario.skip)(`InboundMailPort contract: ${scenario.name}`, () => {
    let port: InboundMailPort;

    beforeEach(() => {
      port = scenario.build();
    });

    it('verifies a correctly-signed webhook and rejects a tampered one', async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const token = 'contract-test-token';
      const goodSignature = computeMailgunSignature(SIGNING_KEY, timestamp, token);

      await expect(port.verify({ timestamp, token, signature: goodSignature })).resolves.toBe(true);
      await expect(
        port.verify({ timestamp, token, signature: 'f'.repeat(goodSignature.length) }),
      ).resolves.toBe(false);
    });

    it('parses the envelope recipient, From address, and DMARC result from a Routes payload', () => {
      const parsed = port.parse({
        recipient: 'cust-abc123+file-def456@share.swenlly.com',
        From: 'Sender Name <sender@example.com>',
        subject: 'File request',
        'body-plain': 'please send the file',
        'Message-Id': '<contract-test@mailgun>',
        token: 'contract-test-token',
        dmarc: 'pass',
        // Fix pass 5, F-B (docs/reviews/critic-report.md): the anti-forgery dedup guard
        // requires `message-headers` to be present at all — a realistic Mailgun payload
        // always carries SOME MIME headers here, this test's own `From` among them.
        'message-headers': JSON.stringify([['From', 'Sender Name <sender@example.com>']]),
      });

      expect(parsed.recipientRaw).toBe('cust-abc123+file-def456@share.swenlly.com');
      expect(parsed.fromAddresses).toEqual(['sender@example.com']);
      expect(parsed.dmarc).toBe('pass');
    });

    it('defaults dmarc to "unknown", never "pass", when the field is absent', () => {
      const parsed = port.parse({
        recipient: 'cust-abc123+file-def456@share.swenlly.com',
        From: 'sender@example.com',
      });
      expect(parsed.dmarc).toBe('unknown');
    });
  });
}

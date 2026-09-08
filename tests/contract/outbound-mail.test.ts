import { beforeEach, describe, expect, it } from 'vitest';
import type { OutboundMailPort } from '../../src/ports/outbound-mail.js';
import { FakeOutboundMail } from '../../src/adapters/mailgun/fake.js';
import { MailgunOutboundAdapter, type MailgunConfig } from '../../src/adapters/mailgun/real.js';

/**
 * `OutboundMailPort` contract suite, run against both adapters (architecture.md §2, §9
 * item 4). The `real` leg only runs with `LIVE_MAILGUN=1` plus real Mailgun credentials —
 * neither is available in this environment, so it reports **skipped, not passed**, and
 * (unlike the other two contract suites) actually sends a real email when it does run —
 * see the warning in `docs/runbooks/live-spikes.md` spike #3 about using a
 * you-control test recipient. See `tests/contract/mailgun-wire.test.ts` for the offline
 * `MockAgent` wire-shape tests that exercise the same request shape unconditionally.
 */

const LIVE = process.env.LIVE_MAILGUN === '1';

if (!LIVE) {
  console.warn(
    '\n[contract/outbound-mail] LIVE_MAILGUN is not set — the real OutboundMailPort ' +
      'contract leg is SKIPPED, not passed. Set LIVE_MAILGUN=1 plus MAILGUN_* credentials ' +
      'to run it for real (docs/runbooks/live-spikes.md spike #3).\n',
  );
}

function buildReal(): OutboundMailPort {
  const config: MailgunConfig = {
    apiBase: process.env.MAILGUN_API_BASE ?? '',
    apiKey: process.env.MAILGUN_API_KEY ?? '',
    signingKey: process.env.MAILGUN_SIGNING_KEY ?? '',
    sendingDomain: process.env.MAILGUN_SENDING_DOMAIN ?? '',
    outboundFrom: process.env.OUTBOUND_FROM ?? '',
  };
  return new MailgunOutboundAdapter(config);
}

const scenarios: { name: string; skip: boolean; build: () => OutboundMailPort }[] = [
  { name: 'fake', skip: false, build: () => new FakeOutboundMail() },
  { name: 'real', skip: !LIVE, build: buildReal },
];

for (const scenario of scenarios) {
  describe.skipIf(scenario.skip)(`OutboundMailPort contract: ${scenario.name}`, () => {
    let port: OutboundMailPort;

    beforeEach(() => {
      port = scenario.build();
    });

    it(
      'sends a text message and returns a provider message id',
      async () => {
        const to = process.env.LIVE_MAILGUN_TEST_RECIPIENT ?? 'contract-test@example.com';
        const result = await port.send({
          to,
          subject: 'Swenlly contract test',
          text: 'This is an OutboundMailPort contract-suite test message.',
        });
        expect(result.providerMessageId).toBeTruthy();
      },
      scenario.name === 'real' ? 30_000 : undefined,
    );

    it(
      'sends an attachment alongside the text body',
      async () => {
        const to = process.env.LIVE_MAILGUN_TEST_RECIPIENT ?? 'contract-test@example.com';
        const result = await port.send({
          to,
          subject: 'Swenlly contract test (attachment)',
          text: 'See attached.',
          attachment: {
            filename: 'contract-test.txt',
            content: Buffer.from('contract test attachment content'),
            contentType: 'text/plain',
          },
        });
        expect(result.providerMessageId).toBeTruthy();
      },
      scenario.name === 'real' ? 30_000 : undefined,
    );
  });
}

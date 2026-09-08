import { createHmac, timingSafeEqual } from 'node:crypto';
import type { InboundMailPort, InboundMessage } from '../../ports/inbound-mail.js';
import type { OutboundAttachment, OutboundMailPort } from '../../ports/outbound-mail.js';
import type { Clock } from '../../ports/clock.js';
import { mapMailgunInboundPayload } from './mapping.js';

const SIGNATURE_WINDOW_SECONDS = 5 * 60;

/**
 * Computes Mailgun's documented webhook signature: `hex(hmac_sha256(signingKey,
 * timestamp + token))`. Exported so tests can mint valid (and, by tweaking the inputs,
 * invalid/expired) signatures without duplicating the algorithm.
 */
export function computeMailgunSignature(
  signingKey: string,
  timestamp: string,
  token: string,
): string {
  return createHmac('sha256', signingKey)
    .update(timestamp + token)
    .digest('hex');
}

/**
 * Semantic fake for `InboundMailPort`: verifies the HMAC exactly like Mailgun does
 * (`timingSafeEqual`, ±5-minute timestamp window against the injected `Clock` so tests can
 * produce "expired" signatures deterministically with virtual time) and maps payloads
 * through the same field-mapping function the real adapter will eventually use
 * (`adapters/mailgun/mapping.ts`), so a test that exercises the fake is exercising real
 * mapping logic, not a shortcut.
 */
export class FakeInboundMail implements InboundMailPort {
  constructor(
    private readonly signingKey: string,
    private readonly clock: Clock,
  ) {}

  async verify(fields: { timestamp: string; token: string; signature: string }): Promise<boolean> {
    const expectedHex = computeMailgunSignature(this.signingKey, fields.timestamp, fields.token);
    const expected = Buffer.from(expectedHex, 'hex');
    let actual: Buffer;
    try {
      actual = Buffer.from(fields.signature, 'hex');
    } catch {
      return false;
    }
    if (actual.length !== expected.length || actual.length === 0) return false;
    if (!timingSafeEqual(actual, expected)) return false;

    const tsSeconds = Number(fields.timestamp);
    if (!Number.isFinite(tsSeconds)) return false;
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1000);
    return Math.abs(nowSeconds - tsSeconds) <= SIGNATURE_WINDOW_SECONDS;
  }

  parse(payload: Record<string, unknown>): InboundMessage {
    return mapMailgunInboundPayload(payload);
  }
}

interface RecordedSend {
  to: string;
  subject: string;
  text: string;
  attachment?: { filename: string; size: number; contentType: string };
}

/** Semantic fake for `OutboundMailPort`: records every send for assertion in tests. */
export class FakeOutboundMail implements OutboundMailPort {
  readonly sent: RecordedSend[] = [];

  async send(message: {
    to: string;
    subject: string;
    text: string;
    attachment?: OutboundAttachment;
  }): Promise<{ providerMessageId: string }> {
    this.sent.push({
      to: message.to,
      subject: message.subject,
      text: message.text,
      attachment: message.attachment
        ? {
            filename: message.attachment.filename,
            size: message.attachment.content.length,
            contentType: message.attachment.contentType,
          }
        : undefined,
    });
    return { providerMessageId: `fake-outbound-${this.sent.length}` };
  }
}

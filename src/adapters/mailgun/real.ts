import type { InboundMailPort, InboundMessage } from '../../ports/inbound-mail.js';
import type { OutboundAttachment, OutboundMailPort } from '../../ports/outbound-mail.js';

export interface MailgunConfig {
  apiBase: string;
  apiKey: string;
  signingKey: string;
  sendingDomain: string;
  outboundFrom: string;
}

/**
 * Real Mailgun inbound adapter. `verify`/`parse` are `@unverified-live`: although
 * Mailgun's HMAC signature scheme is publicly documented, nobody on this project has run
 * it against a real, delivered Mailgun webhook, and the auth-results field names `parse`
 * needs are an outright guess (architecture.md §12) — see
 * `src/adapters/mailgun/mapping.ts` for the exact mapping the real implementation should
 * call once verified. Kept as a throwing stub, like every other real adapter method, so
 * the verification ledger never claims a live call that hasn't happened.
 */
export class MailgunInboundAdapter implements InboundMailPort {
  constructor(private readonly config: MailgunConfig) {}

  /** @unverified-live */
  async verify(_fields: { timestamp: string; token: string; signature: string }): Promise<boolean> {
    throw new Error('not implemented: MailgunInboundAdapter.verify');
  }

  /** @unverified-live */
  parse(_payload: Record<string, unknown>): InboundMessage {
    throw new Error('not implemented: MailgunInboundAdapter.parse');
  }
}

/**
 * Real Mailgun outbound adapter — one multipart POST to the messages API (architecture.md
 * §1: no Mailgun SDK, native `FormData`/`File` via `undici`). `@unverified-live`: no
 * credentials have been exercised.
 */
export class MailgunOutboundAdapter implements OutboundMailPort {
  constructor(private readonly config: MailgunConfig) {}

  /** @unverified-live */
  async send(_message: {
    to: string;
    subject: string;
    text: string;
    attachment?: OutboundAttachment;
  }): Promise<{ providerMessageId: string }> {
    throw new Error('not implemented: MailgunOutboundAdapter.send');
  }
}

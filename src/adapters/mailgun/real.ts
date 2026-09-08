import type { InboundMailPort, InboundMessage } from '../../ports/inbound-mail.js';
import type { OutboundAttachment, OutboundMailPort } from '../../ports/outbound-mail.js';
import type { Clock } from '../../ports/clock.js';
import { PermanentError, TransientError } from '../../ports/errors.js';
import type { PortError } from '../../ports/errors.js';
import { mapMailgunInboundPayload } from './mapping.js';
import { verifyMailgunSignature } from './signature.js';

export interface MailgunConfig {
  apiBase: string;
  apiKey: string;
  signingKey: string;
  sendingDomain: string;
  outboundFrom: string;
}

/**
 * Real Mailgun inbound adapter (architecture.md §1, §2, §4). `verify` delegates its HMAC
 * computation to `adapters/mailgun/signature.ts` (itself reusing
 * `adapters/mailgun/fake.ts`'s `computeMailgunSignature`) and `parse` delegates entirely to
 * `adapters/mailgun/mapping.ts` — this file adds no field-mapping or crypto logic of its
 * own, only the wiring. Both methods are `@unverified-live`: although Mailgun's HMAC
 * signature scheme is publicly documented and the `recipient`/`From`/`subject`/
 * `body-plain`/`Message-Id`/`token` field names are Mailgun's own stable webhook contract
 * (`mapping.ts`'s own doc comment), nobody on this project has run either against a real,
 * delivered Mailgun webhook — and the DMARC/SPF/DKIM auth-results field name is an
 * outright guess pending that live payload (`docs/runbooks/live-spikes.md` spike #3).
 */
export class MailgunInboundAdapter implements InboundMailPort {
  constructor(
    private readonly config: MailgunConfig,
    private readonly clock: Clock,
  ) {}

  /** @unverified-live */
  async verify(fields: { timestamp: string; token: string; signature: string }): Promise<boolean> {
    return verifyMailgunSignature(this.config.signingKey, fields, this.clock);
  }

  /** @unverified-live */
  parse(payload: Record<string, unknown>): InboundMessage {
    return mapMailgunInboundPayload(payload);
  }
}

interface MailgunSendResponse {
  id?: string;
  message?: string;
}

function classifyMailgunError(status: number, body: unknown): PortError {
  const message = `Mailgun messages API: HTTP ${status}`;
  if (status === 429 || status >= 500) return new TransientError(message, { cause: body });
  return new PermanentError(message, { cause: body });
}

/**
 * Real Mailgun outbound adapter — one multipart POST to the messages API via Node's
 * built-in `fetch`/`FormData`/`Blob` (architecture.md §1: no Mailgun SDK; `undici`'s
 * `MockAgent` intercepts the global `fetch` dispatcher the same way it intercepts
 * `undici.request`, confirmed for `tests/contract/mailgun-outbound-real.test.ts`).
 * `@unverified-live`: no credentials have been exercised against Mailgun's real API.
 */
export class MailgunOutboundAdapter implements OutboundMailPort {
  constructor(private readonly config: MailgunConfig) {}

  /** @unverified-live */
  async send(message: {
    to: string;
    subject: string;
    text: string;
    attachment?: OutboundAttachment;
  }): Promise<{ providerMessageId: string }> {
    const form = new FormData();
    form.set('from', this.config.outboundFrom);
    form.set('to', message.to);
    form.set('subject', message.subject);
    form.set('text', message.text);
    // `h:Reply-To` is deliberately left unset (architecture.md §4.11 spec for this
    // method): the reply composer's body/subject/from already carry everything the
    // requester needs, and there is no support mailbox to route a reply to yet — setting
    // one would silently invite replies nobody reads.
    if (message.attachment) {
      const blob = new Blob([new Uint8Array(message.attachment.content)], {
        type: message.attachment.contentType,
      });
      form.set('attachment', blob, message.attachment.filename);
    }

    const url = `${this.config.apiBase}/v3/${this.config.sendingDomain}/messages`;
    const basicAuth = Buffer.from(`api:${this.config.apiKey}`).toString('base64');
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Basic ${basicAuth}` },
        body: form,
      });
    } catch (err) {
      throw new TransientError('network error calling Mailgun messages API', { cause: err });
    }

    const text = await res.text().catch(() => '');
    let json: MailgunSendResponse | undefined;
    try {
      json = text ? (JSON.parse(text) as MailgunSendResponse) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      throw classifyMailgunError(res.status, json);
    }
    if (!json?.id) {
      throw new PermanentError('Mailgun send response contained no message id');
    }
    return { providerMessageId: json.id };
  }
}

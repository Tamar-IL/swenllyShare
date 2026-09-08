import type { InboundMailPort, InboundMessage } from '../../ports/inbound-mail.js';
import type { OutboundAttachment, OutboundMailPort } from '../../ports/outbound-mail.js';
import type { Clock } from '../../ports/clock.js';
import { AmbiguousSendError, PermanentError, TransientError } from '../../ports/errors.js';
import type { PortError } from '../../ports/errors.js';
import {
  DEFAULT_MAILGUN_MAPPING_CONFIG,
  mapMailgunInboundPayload,
  type MailgunMappingConfig,
} from './mapping.js';
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
    // F-1: the DMARC/SPF/DKIM field-mapping config (authserv-id + which sources to trust)
    // — see mapping.ts's doc comment. Optional so every existing call site (contract
    // tests included) that only ever passed `(config, clock)` keeps compiling; production
    // wiring (container.ts) always passes it explicitly, derived from `MAILGUN_AUTHSERV_ID`
    // / `INBOUND_AUTH_SOURCE`.
    private readonly mappingConfig: MailgunMappingConfig = DEFAULT_MAILGUN_MAPPING_CONFIG,
  ) {}

  /** @unverified-live */
  async verify(fields: { timestamp: string; token: string; signature: string }): Promise<boolean> {
    return verifyMailgunSignature(this.config.signingKey, fields, this.clock);
  }

  /** @unverified-live */
  parse(payload: Record<string, unknown>): InboundMessage {
    return mapMailgunInboundPayload(payload, this.mappingConfig);
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
 * Fix pass 5, F-A: classifies a `fetch` rejection — i.e. no HTTP exchange ever
 * completed — into "definitely never reached Mailgun" (safe to treat as a non-send and
 * retry) vs. "genuinely unknown whether Mailgun got it" (`AmbiguousSendError`). Node's
 * `fetch`/undici surfaces the low-level cause as `err.cause` (a `TypeError` wrapping a
 * `SystemError`-shaped object with a `.code`); a connection that was never established at
 * all (refused, DNS failure, unreachable network) could not possibly have delivered any
 * bytes to Mailgun, so it's as safe to retry as an explicit non-2xx response. Anything
 * else — a timeout or reset that could have occurred AFTER the request body was written,
 * an aborted request, an error shape we don't recognize — cannot be proven to have failed
 * before Mailgun received it, so it's ambiguous rather than a guess in either direction.
 */
function classifyMailgunSendException(err: unknown): PortError {
  const cause = err instanceof Error ? (err.cause as { code?: unknown } | undefined) : undefined;
  const code = typeof cause?.code === 'string' ? cause.code : undefined;
  const NEVER_CONNECTED_CODES = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ENETDOWN',
  ]);
  if (code && NEVER_CONNECTED_CODES.has(code)) {
    return new TransientError('network error calling Mailgun messages API (never connected)', {
      cause: err,
    });
  }
  return new AmbiguousSendError(
    'Mailgun messages API call failed with no confirmed response — the message may or may not have been received',
    { cause: err },
  );
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
    deliveryId?: string;
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
    // Fix pass 5, F-A: a deterministic custom variable + Message-Id derived from the
    // delivery id, so a rare double-send (a retried `AmbiguousSendError`, two workers
    // racing a lost advisory lock) is traceable to one delivery row in Mailgun's own logs
    // instead of showing up as two unrelated messages.
    if (message.deliveryId) {
      form.set('v:swenlly-delivery', message.deliveryId);
      form.set(
        'h:Message-Id',
        `<swenlly-delivery-${message.deliveryId}@${this.config.sendingDomain}>`,
      );
    }
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
      throw classifyMailgunSendException(err);
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

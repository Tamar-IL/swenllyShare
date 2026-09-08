import { computeMailgunSignature } from '../../src/adapters/mailgun/fake.js';
import { TEST_SIGNING_KEY, type TestContainer } from './container.js';

export interface WebhookPayloadOptions {
  requestToken: string;
  tenantSlug: string;
  fromAddress?: string;
  /** Multiple From addresses on one message (pipeline gate 6 rejects this). */
  extraFromAddresses?: string[];
  dmarc?: 'pass' | 'fail' | 'none' | 'unknown';
  dmarcDomain?: string;
  spf?: string;
  dkim?: string;
  subject?: string;
  bodyPlain?: string;
  /** Overrides the whole envelope recipient — for injection/grammar tests. */
  recipientOverride?: string;
  separator?: '+' | '--';
  timestampSecondsOverride?: number;
  tokenOverride?: string;
  providerMessageId?: string;
  signatureOverride?: string;
}

/**
 * Builds a full Mailgun-inbound-route-shaped payload, correctly HMAC-signed for
 * `container`'s fake `InboundMailPort`, for use directly with
 * `RequestPipeline.handleWebhook` or the real `POST /webhooks/mailgun/inbound` route.
 * Every field can be overridden individually so one helper covers the happy path,
 * injection, DMARC, and signature test groups.
 */
export function buildSignedWebhookPayload(
  container: TestContainer,
  opts: WebhookPayloadOptions,
): Record<string, unknown> {
  const nowSeconds = Math.floor(container.ports.clock.now().getTime() / 1000);
  const timestamp = String(opts.timestampSecondsOverride ?? nowSeconds);
  const token = opts.tokenOverride ?? `tok-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  const signature =
    opts.signatureOverride ??
    computeMailgunSignature(
      container.config.MAILGUN_SIGNING_KEY ?? TEST_SIGNING_KEY,
      timestamp,
      token,
    );

  const separator = opts.separator ?? '+';
  const recipient =
    opts.recipientOverride ??
    `cust-${opts.tenantSlug}${separator}file-${opts.requestToken}@${container.config.INBOUND_DOMAIN}`;

  const fromAddresses = [
    opts.fromAddress ?? 'sender@example.com',
    ...(opts.extraFromAddresses ?? []),
  ];
  const fromHeader = fromAddresses.map((a) => `<${a}>`).join(', ');

  const payload: Record<string, unknown> = {
    recipient,
    From: fromHeader,
    subject: opts.subject ?? 'בקשה לקבל קובץ',
    'body-plain': opts.bodyPlain ?? '',
    'Message-Id': opts.providerMessageId ?? `<${token}@mailgun.test>`,
    timestamp,
    token,
    signature,
  };
  if (opts.dmarc !== undefined) payload.dmarc = opts.dmarc;
  if (opts.dmarcDomain !== undefined) payload['dmarc-domain'] = opts.dmarcDomain;
  if (opts.spf !== undefined) payload.spf = opts.spf;
  if (opts.dkim !== undefined) payload.dkim = opts.dkim;

  return payload;
}

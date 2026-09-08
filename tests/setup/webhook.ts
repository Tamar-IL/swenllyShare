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
  if (opts.dmarcDomain !== undefined) {
    payload['dmarc-domain'] = opts.dmarcDomain;
  } else if (opts.dmarc === 'pass') {
    // F-2 hardening (docs/security/red-team-report.md): gate 6 now quarantines a `pass`
    // with NO evaluated domain available anywhere (`dmarc_alignment_unknown`) — a real
    // provider `pass` always carries the domain it was evaluated against. Auto-supply a
    // well-formed `Authentication-Results` header aligned to the message's own `From`
    // domain, so every OTHER test in this suite that asks this fixture for a plain
    // `dmarc: 'pass'` happy path keeps getting a REALISTIC pass without needing to know
    // about this gate. A test that wants the domain-less or mismatched cases specifically
    // still gets them: pass `dmarcDomain` for a mismatch, or bypass this option entirely
    // and set `payload.dmarc`/`payload['Authentication-Results']` by hand afterward (as
    // `tests/redteam/auth-gate-bypass.test.ts`'s F-2 cases do).
    const alignedDomain = fromAddresses[0]?.split('@').pop() ?? '';
    payload['Authentication-Results'] = authenticationResultsHeader({ headerFrom: alignedDomain });
  }
  if (opts.spf !== undefined) payload.spf = opts.spf;
  if (opts.dkim !== undefined) payload.dkim = opts.dkim;

  return payload;
}

/**
 * Builds a well-formed `Authentication-Results` header VALUE (RFC 8601-shaped) for tests
 * that want to exercise the REAL primary auth-results path (`mapping.ts`'s source (a))
 * instead of the guessed classic `dmarc`/`dmarc-domain` top-level fields (source (b)) —
 * this is what a genuine Mailgun `pass` looks like. F-2 hardening
 * (`docs/security/red-team-report.md`): a `dmarc=pass` with no `header.from=` at all is
 * never trustworthy (`request-pipeline.ts` gate 6 quarantines it as
 * `dmarc_alignment_unknown`), so any test payload asserting a `pass` proceeds must supply
 * one via this helper rather than a bare `dmarc: 'pass'` with no evaluated domain.
 */
export function authenticationResultsHeader(opts: {
  dmarc?: string;
  headerFrom: string;
  authservId?: string;
}): string {
  const authservId = opts.authservId ?? 'mx.mailgun.org';
  return `${authservId}; dmarc=${opts.dmarc ?? 'pass'} header.from=${opts.headerFrom}`;
}

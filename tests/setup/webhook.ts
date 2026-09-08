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
  /**
   * Fix pass 5, F-B: when `false`, the fixture omits `message-headers` entirely — the
   * one shape `mapMailgunInboundPayload` now fails closed on (every auth field reads
   * `unknown`/`null`, regardless of what any other field claims). Every test gets this
   * `true` (a realistic payload — Mailgun's inbound routes always flatten SOME MIME
   * headers) unless it specifically wants to exercise the absent-`message-headers` case.
   */
  includeMessageHeaders?: boolean;
}

/**
 * Builds a full Mailgun-inbound-route-shaped payload, correctly HMAC-signed for
 * `container`'s fake `InboundMailPort`, for use directly with
 * `RequestPipeline.handleWebhook` or the real `POST /webhooks/mailgun/inbound` route.
 * Every field can be overridden individually so one helper covers the happy path,
 * injection, DMARC, and signature test groups.
 *
 * Fix pass 5, F-B (`docs/reviews/critic-report.md`): always includes a `message-headers`
 * array (unless `includeMessageHeaders: false`) — `mapMailgunInboundPayload`'s anti-
 * forgery guard depends entirely on it being present, so a fixture that never set it was
 * accidentally exercising a degraded/unrealistic shape on every single test in the suite,
 * not the well-formed one. A `dmarc: 'pass'` option supplies BOTH a synthetic top-level
 * `dmarc-domain` field (source (a), tried first) and a matching `Authentication-Results`
 * `message-headers` entry (source (b)) aligned to the message's own `From` domain, so
 * every happy-path test gets a REALISTIC pass regardless of which source it happens to
 * exercise. A test that wants the domain-less/mismatched/absent-message-headers cases
 * specifically still gets them: pass `dmarcDomain` for a mismatch, `includeMessageHeaders:
 * false` for the fail-closed case, or bypass this option and use `pushMessageHeader`/set
 * fields by hand afterward (as `tests/redteam/auth-gate-bypass.test.ts`'s F-1/F-2 cases do).
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
  const subject = opts.subject ?? 'בקשה לקבל קובץ';

  const payload: Record<string, unknown> = {
    recipient,
    From: fromHeader,
    subject,
    'body-plain': opts.bodyPlain ?? '',
    'Message-Id': opts.providerMessageId ?? `<${token}@mailgun.test>`,
    timestamp,
    token,
    signature,
  };

  // The baseline "Mailgun flattened the message's own MIME headers" array — realistic
  // even when nothing DMARC-related is being tested, and required for the dedup guard
  // that makes trusting anything else in this payload legitimate at all.
  const messageHeaders: [string, string][] = [['From', fromHeader]];

  if (opts.dmarc !== undefined) payload.dmarc = opts.dmarc;
  if (opts.dmarcDomain !== undefined) {
    payload['dmarc-domain'] = opts.dmarcDomain;
  } else if (opts.dmarc === 'pass') {
    // F-2 hardening (docs/security/red-team-report.md): gate 6 now quarantines a `pass`
    // with NO evaluated domain available anywhere (`dmarc_alignment_unknown`) — a real
    // provider `pass` always carries the domain it was evaluated against. Auto-supply the
    // aligned domain via BOTH recognized sources so every OTHER test in this suite that
    // asks this fixture for a plain `dmarc: 'pass'` happy path keeps getting a REALISTIC
    // pass regardless of `INBOUND_AUTH_SOURCE`.
    const alignedDomain = fromAddresses[0]?.split('@').pop() ?? '';
    payload['dmarc-domain'] = alignedDomain;
    messageHeaders.push([
      'Authentication-Results',
      authenticationResultsHeader({ headerFrom: alignedDomain }),
    ]);
  }
  if (opts.spf !== undefined) payload.spf = opts.spf;
  if (opts.dkim !== undefined) payload.dkim = opts.dkim;

  if (opts.includeMessageHeaders ?? true) {
    payload['message-headers'] = JSON.stringify(messageHeaders);
  }

  return payload;
}

/**
 * Appends one `[name, value]` entry to `payload['message-headers']` (parsing it first if
 * it's already the JSON-string form `buildSignedWebhookPayload` produces, or starting a
 * fresh array if absent) and re-stringifies. The one way tests should add an
 * `Authentication-Results` entry (or any other MIME header) to a payload built by
 * `buildSignedWebhookPayload` — setting `payload['Authentication-Results']` directly sets
 * a TOP-LEVEL field, which fix pass 5 (F-B) no longer reads at all.
 */
export function pushMessageHeader(
  payload: Record<string, unknown>,
  name: string,
  value: string,
): void {
  const raw = payload['message-headers'];
  const existing: [string, string][] = typeof raw === 'string' ? JSON.parse(raw) : [];
  existing.push([name, value]);
  payload['message-headers'] = JSON.stringify(existing);
}

/**
 * Builds a well-formed `Authentication-Results` header VALUE (RFC 8601-shaped) — this is
 * what a genuine Mailgun-stamped `pass` looks like when parsed out of `message-headers`
 * (`mapping.ts`'s source (b)). F-2 hardening (`docs/security/red-team-report.md`): a
 * `dmarc=pass` with no `header.from=` at all is never trustworthy (`request-pipeline.ts`
 * gate 6 quarantines it as `dmarc_alignment_unknown`), so any test payload asserting a
 * `pass` proceeds must supply one via this helper rather than a bare `dmarc: 'pass'` with
 * no evaluated domain. `authservId` defaults to the same value
 * `tests/setup/container.ts`'s `buildTestConfig` configures `MAILGUN_AUTHSERV_ID` as, so a
 * call site that doesn't care about authserv-id matching gets a header that matches by
 * default.
 */
export function authenticationResultsHeader(opts: {
  dmarc?: string;
  headerFrom: string;
  authservId?: string;
}): string {
  const authservId = opts.authservId ?? 'mxa.mailgun.test';
  return `${authservId}; dmarc=${opts.dmarc ?? 'pass'} header.from=${opts.headerFrom}`;
}

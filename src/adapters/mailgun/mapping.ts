import type { InboundMessage } from '../../ports/inbound-mail.js';

/**
 * Maps Mailgun's raw inbound-route form payload into our normalized `InboundMessage` DTO.
 *
 * `recipient`, `from`/`From`, `subject`, `body-plain`, `Message-Id`, `timestamp` and
 * `token` are Mailgun's own stable, documented webhook field names (Routes / Store-and-
 * notify), not a guess. What IS unverified (architecture.md §12) is which field(s) carry
 * the DMARC/SPF/DKIM authentication-results Mailgun attaches — Mailgun's docs describe
 * this inconsistently across plans and inbound route configurations, and nobody on this
 * project has seen a live payload yet. So: probe a short list of plausible key names for
 * each, in priority order, and if none of them yields a recognized value, default to
 * `'unknown'` for `dmarc` — NEVER infer `'pass'` from an absent field (architecture.md
 * §4.5: "We never re-derive DMARC and never infer pass from absence"). Once a real
 * payload has been observed, narrow this list to the one true key and drop the rest.
 */
const DMARC_KEY_CANDIDATES = [
  'dmarc',
  'Dmarc',
  'X-Mailgun-Dmarc-Result',
  'dmarc-result',
  'Dmarc-Result',
] as const;

const SPF_KEY_CANDIDATES = ['spf', 'Spf', 'X-Mailgun-Spf', 'spf-result'] as const;

const DKIM_KEY_CANDIDATES = ['dkim', 'Dkim', 'X-Mailgun-Dkim-Result', 'dkim-result'] as const;

const DMARC_DOMAIN_KEY_CANDIDATES = [
  'dmarc-domain',
  'Dmarc-Domain',
  'X-Mailgun-Dmarc-Domain',
] as const;

function firstStringField(
  payload: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function extractDmarc(payload: Record<string, unknown>): InboundMessage['dmarc'] {
  const raw = firstStringField(payload, DMARC_KEY_CANDIDATES);
  const normalized = raw?.toLowerCase();
  if (normalized === 'pass' || normalized === 'fail' || normalized === 'none') {
    return normalized;
  }
  return 'unknown';
}

/**
 * Extracts every email address in a `From:`-style header value. Handles the common
 * `"Display Name" <addr@host>` form and bare-address form, and — critically for pipeline
 * gate 6 (architecture.md §4.6, "exactly one `From` address") — a comma-separated list of
 * multiple addresses, which the pipeline must reject rather than silently pick one from.
 */
export function extractAddresses(headerValue: string): string[] {
  const matches = headerValue.matchAll(/<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g);
  const addresses: string[] = [];
  for (const match of matches) {
    const addr = match[1] ?? match[2];
    if (addr) addresses.push(addr.trim().toLowerCase());
  }
  return addresses;
}

export function mapMailgunInboundPayload(payload: Record<string, unknown>): InboundMessage {
  const recipientRaw = String(payload.recipient ?? '')
    .trim()
    .toLowerCase();
  const fromHeader = String(payload.From ?? payload.from ?? '');
  const fromAddresses = extractAddresses(fromHeader);
  const providerMessageId = String(payload['Message-Id'] ?? payload['message-id'] ?? '');
  const signatureToken = String(payload.token ?? '');
  const subject = typeof payload.subject === 'string' ? payload.subject : null;
  const bodyPlain =
    typeof payload['body-plain'] === 'string' ? (payload['body-plain'] as string) : null;

  return {
    providerMessageId,
    signatureToken,
    recipientRaw,
    fromAddresses,
    dmarc: extractDmarc(payload),
    spf: firstStringField(payload, SPF_KEY_CANDIDATES),
    dkim: firstStringField(payload, DKIM_KEY_CANDIDATES),
    dmarcDomain: firstStringField(payload, DMARC_DOMAIN_KEY_CANDIDATES),
    subject,
    bodyPlain,
    rawPayload: payload,
  };
}

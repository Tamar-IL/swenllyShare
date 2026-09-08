/**
 * Mailgun Routes — the inbound side (architecture.md §2, §4). `verify` is pipeline gate 1
 * (signature) and must run before any parsing of untrusted request data. `parse` reads the
 * DTO fields the pipeline needs; live field names for the auth-results (DMARC/SPF/DKIM)
 * portion of Mailgun's payload are UNVERIFIED (architecture.md §12), so the real adapter's
 * `parse` is the one place that mapping lives, with a comment explaining the guess and a
 * `dmarc: 'unknown'` default when the field is absent — never inferred as `'pass'`.
 */

/** Everything the request pipeline needs from one inbound message, already normalized. */
export interface InboundMessage {
  /** Mailgun's own message id — the natural key for `inbound_messages.provider_message_id`. */
  providerMessageId: string;
  /** The webhook's `token` field — the natural key for `inbound_messages.signature_token`,
   * the replay-detection unique index (architecture.md §3, §4.2). */
  signatureToken: string;
  /** The envelope recipient (`recipient` field) — the ONLY address the pipeline parses
   * for tenant/file resolution (architecture.md §4.3). Lowercased. */
  recipientRaw: string;
  /** The `From:` header address(es) as Mailgun reports them, unparsed — pipeline gate 6
   * rejects anything but exactly one. */
  fromAddresses: string[];
  /** DMARC result Mailgun attached to this message. Defaults to `'unknown'` when the
   * field is absent from the payload — never inferred as `'pass'` (architecture.md §4.5). */
  dmarc: 'pass' | 'fail' | 'none' | 'unknown';
  spf: string | null;
  dkim: string | null;
  /** The domain DMARC was evaluated against, when the provider reports one. */
  dmarcDomain: string | null;
  subject: string | null;
  bodyPlain: string | null;
  /** Full raw payload, retained (per `RAW_PAYLOAD_RETENTION_DAYS`) for spoofing-report
   * debugging (architecture.md §10). */
  rawPayload: Record<string, unknown>;
}

export interface InboundMailPort {
  /**
   * Verifies Mailgun's HMAC-SHA256 signature over `timestamp + token` with the signing
   * key, constant-time compared, and (per architecture.md §4.1) that `timestamp` is within
   * ±5 minutes of now. `rawBody` is the parsed form fields (Mailgun signs `timestamp` and
   * `token` fields, not the raw HTTP body).
   */
  verify(fields: { timestamp: string; token: string; signature: string }): Promise<boolean>;

  /** Maps Mailgun's raw form payload into the normalized `InboundMessage` DTO. */
  parse(payload: Record<string, unknown>): InboundMessage;
}

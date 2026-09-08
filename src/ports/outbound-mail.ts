/**
 * Mailgun's messages API — the outbound side (architecture.md §2, §4.11). Used by
 * `delivery.fulfill` to send either the attachment reply or the Drive-share reply
 * (AC-R4/R5), and by `Auth` to send the magic-link email.
 */
export interface OutboundAttachment {
  filename: string;
  /** Streamed or buffered content — small enough (`<= ATTACH_LIMIT_BYTES`) to hold in memory
   * for a single multipart POST (architecture.md §1: native `FormData`/`File`, no SDK). */
  content: Buffer;
  contentType: string;
}

export interface OutboundMailPort {
  /**
   * Sends one email. `attachment`, when present, is inlined as a multipart attachment.
   *
   * `deliveryId`, when present, is `delivery.fulfill`'s own `deliveries.id` (fix pass 5,
   * F-A: `docs/reviews/critic-report.md`) — the real Mailgun adapter stamps it as a
   * deterministic `v:swenlly-delivery` custom variable and derives a stable `Message-Id`
   * from it, so a rare double-send (an `AmbiguousSendError` retried by a human, or two
   * workers racing a lost lock) is traceable back to the exact delivery row rather than
   * showing up as two unrelated-looking messages in Mailgun's log. Optional because the
   * magic-link send (`domain/auth.ts`) has no `deliveries` row to key off.
   */
  send(message: {
    to: string;
    subject: string;
    text: string;
    attachment?: OutboundAttachment;
    deliveryId?: string;
  }): Promise<{ providerMessageId: string }>;
}

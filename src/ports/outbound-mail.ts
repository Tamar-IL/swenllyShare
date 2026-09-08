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
  /** Sends one email. `attachment`, when present, is inlined as a multipart attachment. */
  send(message: {
    to: string;
    subject: string;
    text: string;
    attachment?: OutboundAttachment;
  }): Promise<{ providerMessageId: string }>;
}

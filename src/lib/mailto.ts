import { buildRequestAddress } from './addressing.js';

/**
 * Builds the pre-filled `mailto:` request link shown on the per-file page
 * (architecture.md §7; UX brief §3). The recipient's mail client lets them edit or send
 * as-is — delivery never depends on subject/body content, only on the `+file-<token>`
 * address (AC-R2), so an edited or garbled body is harmless.
 */
export function buildMailtoUrl(params: {
  slug: string;
  token: string;
  inboundDomain: string;
  displayName: string;
}): string {
  const address = buildRequestAddress(params.slug, params.token, params.inboundDomain);
  const subject = `בקשה לקבל קובץ: ${params.displayName}`;
  const body = [
    'שלום,',
    `אני מבקש/ת לקבל את הקובץ "${params.displayName}".`,
    'אנא השב/י למייל זה עם הקובץ.',
  ].join('\r\n');

  // encodeURIComponent turns "\r\n" into "%0D%0A" and percent-encodes everything else a
  // mailto URL needs escaped (architecture.md §7: "CRLF encoded as %0D%0A, whole string
  // percent-encoded with encodeURIComponent semantics").
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

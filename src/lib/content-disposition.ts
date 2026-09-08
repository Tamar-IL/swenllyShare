/**
 * Builds a `Content-Disposition: attachment` header value safe for a Hebrew (or any
 * non-ASCII) display name: an ASCII-only fallback `filename` for older clients plus the
 * RFC 5987 `filename*=UTF-8''<percent-encoded>` form real browsers use (architecture.md
 * §10: "downloads always Content-Disposition: attachment with a sanitized filename").
 */
export function contentDispositionAttachment(filename: string): string {
  const asciiFallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(filename).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  );
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

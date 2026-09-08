/**
 * Small, shared helpers for the offline `undici` `MockAgent` wire-shape tests
 * (`google-drive-wire.test.ts`, `zoho-workdrive-wire.test.ts`, `mailgun-wire.test.ts`).
 * Not a `.test.ts` file itself — imported by the ones that are.
 */

/**
 * Reads a `MockResponseCallbackOptions.body` (string | Buffer | stream | null) into a
 * `Buffer`, regardless of which shape `undici` handed the reply callback for a given
 * request body type. Streamed bodies (multipart uploads, chunked PUTs) are consumed here,
 * not skipped — that's the whole point of a wire-shape test.
 */
export async function readMockBodyBuffer(body: unknown): Promise<Buffer> {
  if (body === null || body === undefined) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function readMockBodyText(body: unknown): Promise<string> {
  return (await readMockBodyBuffer(body)).toString('utf8');
}

/** A `MockInterceptor` path matcher that ignores the query string entirely. Pair with
 * inspecting `opts.path` inside `reply()` (which reflects the literal request path in its
 * original, non-reordered param order) for query-string assertions — the declarative
 * `path`/`query` matchers on the interceptor itself reorder query params alphabetically
 * before matching, which makes exact-string matching brittle for multi-param URLs. */
export function pathnameIs(pathname: string): (path: string) => boolean {
  return (path: string) => path.split('?')[0] === pathname;
}

export function mockUrl(path: string): URL {
  return new URL(`http://mock-host${path}`);
}

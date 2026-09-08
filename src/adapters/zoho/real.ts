import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { request } from 'undici';
import type { FileStorePort } from '../../ports/file-store.js';
import { NotFoundError, PermanentError, TransientError } from '../../ports/errors.js';
import type { PortError } from '../../ports/errors.js';

/**
 * Files at or under this size go through the simple `/upload` endpoint; larger files go
 * through the session-based large-file path. 250 MB is the ceiling reported for
 * WorkDrive's plain upload endpoint in a third-party integration's own bug report (an
 * `rclone` GitHub issue quoting WorkDrive's own error for files over that size) — not a
 * primary Zoho doc page (egress-blocked, `research/05` §2). Treat as corroborated-by-
 * community, not confirmed; verify against a live account before relying on the exact
 * number (`docs/runbooks/live-spikes.md` spike #1).
 */
const SIMPLE_UPLOAD_MAX_BYTES = 250 * 1024 * 1024;

/** Arbitrary — no documented chunk-size requirement was found for the large-file path
 * (unlike Google's well-documented "multiples of 256 KiB" rule). 10 MiB balances request
 * count against memory per in-flight chunk; revisit once the real endpoint is confirmed. */
const ZOHO_CHUNK_SIZE_BYTES = 10 * 1024 * 1024;

const DEFAULT_ACCOUNTS_BASE = 'https://accounts.zoho.com';
/** A safety margin subtracted from the token's reported `expires_in` so a request started
 * just before real expiry doesn't race a now-invalid token. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export interface ZohoFileStoreConfig {
  apiBase: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  teamFolderId: string;
  /** OAuth token-endpoint host — defaults to the global DC. EU/IN/AU/CN/JP data centers
   * use `accounts.zoho.eu` / `.in` / `.com.au` / `.com.cn` / `.jp` respectively; get this
   * wrong and every call fails with an invalid-token error that looks like a credentials
   * problem, not a DC problem (architecture.md §2 calls this out explicitly). */
  accountsBase?: string;
  /**
   * WorkDrive's `role_id` for a newly created external link. Community-sourced mapping
   * (a public Deluge reference implementation, not a primary doc page — same egress
   * constraint as above): `5` = edit, `6` = view, `7` = upload (folders only). Default
   * `"6"` (view) — `allow_download` on the link body is the separate flag that actually
   * controls download capability, per the same source. **UNCONFIRMED** against Zoho's own
   * docs; verify with one live `POST /links` call and record the observed mapping in the
   * ledger note, not just the code comment (`docs/runbooks/live-spikes.md` spike #1).
   */
  linkRoleId: string;
  /** Test seams only — `container.ts` never sets these. Let
   * `tests/contract/zoho-workdrive-wire.test.ts` exercise the large-file chunked-upload
   * path without allocating a real 250MB+ buffer, by shrinking both thresholds. Production
   * always uses `SIMPLE_UPLOAD_MAX_BYTES` / `ZOHO_CHUNK_SIZE_BYTES`. */
  simpleUploadMaxBytes?: number;
  chunkSizeBytes?: number;
}

interface ZohoTokenResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  error?: string;
}

interface ZohoUploadResponse {
  data?: { id?: string; attributes?: { resource_id?: string } }[];
}

interface ZohoLargeFileResponse {
  data?: { id?: string; attributes?: { resource_id?: string } };
}

interface ZohoLinkResponse {
  data?: {
    id?: string;
    attributes?: {
      link?: string;
      url?: string;
      embed_url?: string;
      embed_link?: string;
      [key: string]: unknown;
    };
  };
}

function classifyZohoError(status: number, body: unknown): PortError {
  const message = `Zoho WorkDrive API: HTTP ${status}`;
  if (status === 429 || status >= 500) return new TransientError(message, { cause: body });
  if (status === 404) return new NotFoundError(message, { cause: body });
  return new PermanentError(message, { cause: body });
}

async function readJsonBody(res: { body: { text(): Promise<string> } }): Promise<unknown> {
  const text = await res.body.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Minimal, dependency-free `multipart/form-data` body builder — architecture.md §1 rules
 * out a Mailgun/HTTP client SDK, and the same "no SDK, hand-roll the one shape we need"
 * spirit applies here: `undici` has no built-in multipart *writer* (only a *parser* for
 * `@fastify/multipart`-style consumption), and pulling in `form-data` for one field would
 * be the exact kind of dependency this codebase avoids. Streams the file part directly —
 * never buffers it — so upload memory stays flat regardless of file size. */
function buildMultipartBody(
  fields: Record<string, string>,
  filePart: { fieldName: string; filename: string; contentType: string; stream: Readable },
): { stream: Readable; contentType: string } {
  const boundary = `swenlly-${randomBytes(16).toString('hex')}`;
  const CRLF = '\r\n';
  const sanitizedFilename = filePart.filename.replace(/["\r\n]/g, '_');

  const preamble: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    preamble.push(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${value}${CRLF}`,
    );
  }
  preamble.push(
    `--${boundary}${CRLF}Content-Disposition: form-data; name="${filePart.fieldName}"; ` +
      `filename="${sanitizedFilename}"${CRLF}Content-Type: ${filePart.contentType}${CRLF}${CRLF}`,
  );
  const preambleBuf = Buffer.from(preamble.join(''), 'utf8');
  const epilogueBuf = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');

  async function* combined(): AsyncGenerator<Buffer> {
    yield preambleBuf;
    for await (const chunk of filePart.stream) {
      yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    }
    yield epilogueBuf;
  }

  return {
    stream: Readable.from(combined()),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function* chunkStream(stream: Readable, chunkSize: number): AsyncGenerator<Buffer> {
  let buffered: Buffer[] = [];
  let bufferedLen = 0;
  for await (const piece of stream) {
    const buf: Buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
    buffered.push(buf);
    bufferedLen += buf.length;
    while (bufferedLen >= chunkSize) {
      const combined = Buffer.concat(buffered, bufferedLen);
      yield combined.subarray(0, chunkSize);
      const rest = combined.subarray(chunkSize);
      buffered = rest.length > 0 ? [rest] : [];
      bufferedLen = rest.length;
    }
  }
  if (bufferedLen > 0) yield Buffer.concat(buffered, bufferedLen);
}

/**
 * Extracts an embed token for `workdrive.zohoexternal.com/embed/<token>`
 * (`research/08 §1a`) from a create-link response, if one is present under a plausible
 * field name — else derives a best-effort fallback from the plain link's own trailing
 * path segment. The fallback is explicitly **not** a verified embed token: nothing found
 * in search-snippet research confirmed WorkDrive's `POST /links` response ever contains a
 * distinct embed identifier at all. Whichever path is taken, the branded page (behind
 * `BRANDED_PAGE_ENABLED`, off by default) must not be trusted until a live response is
 * inspected — `docs/runbooks/live-spikes.md` spike #4.
 */
function extractOrDeriveEmbedToken(attrs: Record<string, unknown>, plainUrl: string): string {
  const embedCandidate = attrs.embed_url ?? attrs.embed_link;
  if (typeof embedCandidate === 'string') {
    const match = embedCandidate.match(/\/embed\/([^/?#]+)/);
    if (match?.[1]) return match[1];
  }
  const segments = new URL(plainUrl).pathname.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? plainUrl;
}

/**
 * Real Zoho WorkDrive adapter (architecture.md §1, §2). Every method is
 * `@unverified-live` — no live call to Zoho's API has been made by anyone on this project
 * (`research/05 §2`, `research/08 §1a`). What's corroborated vs. guessed, precisely:
 *  - OAuth refresh-token flow against `{accountsBase}/oauth/v2/token` and the
 *    `Zoho-oauthtoken <token>` authorization header are Zoho's own standard, cross-product
 *    OAuth2 convention (not WorkDrive-specific) — high confidence despite being untested
 *    here.
 *  - `POST {apiBase}/links` (JSON:API envelope, `resource_id`/`link_name`/`allow_download`/
 *    `request_user_data`/`role_id`) and `POST {apiBase}/upload` (multipart, `parent_id` +
 *    file content, ≤250MB) are corroborated by a public reference implementation and
 *    multiple community threads — see the inline comments at each call site for sources.
 *  - The large-file (`>250MB`) upload session shape is a **modeled guess** with no
 *    field-level confirmation found anywhere reachable this session — flagged loudly at
 *    its definition below.
 *  - The embed-token derivation is flagged separately (see `extractOrDeriveEmbedToken`).
 */
export class ZohoFileStore implements FileStorePort {
  private tokenCache?: { accessToken: string; expiresAtMs: number };

  constructor(private readonly config: ZohoFileStoreConfig) {}

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && now < this.tokenCache.expiresAtMs - TOKEN_REFRESH_SKEW_MS) {
      return this.tokenCache.accessToken;
    }
    const accountsBase = this.config.accountsBase ?? DEFAULT_ACCOUNTS_BASE;
    const url = `${accountsBase}/oauth/v2/token`;
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
    });
    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch (err) {
      throw new TransientError('network error refreshing Zoho OAuth token', { cause: err });
    }
    const json = (await readJsonBody(res)) as ZohoTokenResponse | undefined;
    if (res.statusCode < 200 || res.statusCode >= 300 || !json?.access_token) {
      throw classifyZohoError(res.statusCode, json);
    }
    const expiresInMs = (json.expires_in ?? 3600) * 1000;
    this.tokenCache = { accessToken: json.access_token, expiresAtMs: now + expiresInMs };
    return json.access_token;
  }

  private async zohoRequest<T>(
    method: string,
    url: string,
    opts: { body?: string | Buffer | Readable; extraHeaders?: Record<string, string> } = {},
  ): Promise<T> {
    const token = await this.getAccessToken();
    let res;
    try {
      res = await request(url, {
        method,
        headers: {
          authorization: `Zoho-oauthtoken ${token}`,
          accept: 'application/vnd.api+json',
          ...opts.extraHeaders,
        },
        body: opts.body,
      });
    } catch (err) {
      throw new TransientError('network error calling Zoho WorkDrive API', { cause: err });
    }
    const json = await readJsonBody(res);
    if (res.statusCode >= 200 && res.statusCode < 300) return json as T;
    throw classifyZohoError(res.statusCode, json);
  }

  /**
   * Simple upload path (`<= SIMPLE_UPLOAD_MAX_BYTES`). Corroborated by community
   * references: `POST {apiBase}/upload`, multipart body with `parent_id` (target folder)
   * and the file under a `content` field, `override-name-exist=true` to avoid a duplicate-
   * name error on republish/retry.
   */
  private async uploadSimple(
    parentId: string,
    stream: Readable,
    name: string,
  ): Promise<{ resourceId: string }> {
    const { stream: body, contentType } = buildMultipartBody(
      { parent_id: parentId, filename: name, 'override-name-exist': 'true' },
      { fieldName: 'content', filename: name, contentType: 'application/octet-stream', stream },
    );
    const url = `${this.config.apiBase}/upload`;
    const json = await this.zohoRequest<ZohoUploadResponse>('POST', url, {
      body,
      extraHeaders: { 'content-type': contentType },
    });
    const entry = json.data?.[0];
    const resourceId = entry?.attributes?.resource_id ?? entry?.id;
    if (!resourceId) throw new PermanentError('Zoho upload response contained no resource id');
    return { resourceId };
  }

  /**
   * Large-file path (`> SIMPLE_UPLOAD_MAX_BYTES`) — **modeled, not confirmed**. Zoho's own
   * community/support threads name a distinct large-file upload flow once a file exceeds
   * WorkDrive's plain `/upload` ceiling, but no field-level request/response shape for it
   * was reachable this session (`research/05 §2`: `workdrive.zoho.com` egress-blocked).
   * What follows is a session-based shape modeled on WorkDrive's own JSON:API envelope
   * conventions and on Drive's sibling resumable-upload protocol (init → ranged chunk PUT
   * → finalize) — every field name is a hypothesis to validate against a live sandbox call
   * before this code path ever runs for real (`docs/runbooks/live-spikes.md` spike #1).
   */
  private async uploadLargeFile(
    parentId: string,
    stream: Readable,
    sizeBytes: number,
    name: string,
  ): Promise<{ resourceId: string }> {
    const initUrl = `${this.config.apiBase}/uploadlargefile/sessions`;
    const initBody = JSON.stringify({
      data: {
        type: 'files',
        attributes: {
          parent_id: parentId,
          filename: name,
          size: sizeBytes,
          'override-name-exist': true,
        },
      },
    });
    const initJson = await this.zohoRequest<{ data?: { id?: string } }>('POST', initUrl, {
      body: initBody,
      extraHeaders: { 'content-type': 'application/vnd.api+json' },
    });
    const uploadId = initJson.data?.id;
    if (!uploadId) {
      throw new PermanentError('Zoho uploadlargefile session init returned no session id');
    }

    const sessionUrl = `${this.config.apiBase}/uploadlargefile/sessions/${encodeURIComponent(uploadId)}`;
    const chunkSize = this.config.chunkSizeBytes ?? ZOHO_CHUNK_SIZE_BYTES;
    let uploaded = 0;
    let resourceId: string | undefined;
    for await (const chunk of chunkStream(stream, chunkSize)) {
      const start = uploaded;
      const end = uploaded + chunk.length - 1;
      const isFinal = end + 1 >= sizeBytes;
      const chunkJson = await this.zohoRequest<ZohoLargeFileResponse>('PUT', sessionUrl, {
        body: chunk,
        extraHeaders: {
          'content-range': `bytes ${start}-${end}/${sizeBytes}`,
          'content-length': String(chunk.length),
        },
      });
      uploaded += chunk.length;
      if (isFinal) {
        resourceId = chunkJson.data?.attributes?.resource_id ?? chunkJson.data?.id;
      }
    }
    if (!resourceId) {
      throw new PermanentError('Zoho uploadlargefile session finished without a resource id');
    }
    return { resourceId };
  }

  /** @unverified-live */
  async upload(
    tenantFolder: string,
    stream: Readable,
    sizeBytes: number,
    name: string,
  ): Promise<{ resourceId: string }> {
    // No per-tenant subfolder is provisioned by this port (it exposes no create-folder
    // method) — every upload lands directly in `ZOHO_TEAM_FOLDER_ID`. `tenantFolder`
    // (== the caller's `tenantId`, per `FilesService.publishFile`) is accepted for
    // interface stability but not yet used to namespace storage; a real per-tenant
    // WorkDrive folder tree is a follow-up, not required for the MVP's file-count scale.
    // This is a design assumption, not a live-verified fact — flagged for the architect.
    void tenantFolder;
    const parentId = this.config.teamFolderId;
    const threshold = this.config.simpleUploadMaxBytes ?? SIMPLE_UPLOAD_MAX_BYTES;
    if (sizeBytes <= threshold) {
      return this.uploadSimple(parentId, stream, name);
    }
    return this.uploadLargeFile(parentId, stream, sizeBytes, name);
  }

  /**
   * @unverified-live
   * `role_id` mapping and `Accept: application/vnd.api+json` requirement per the class
   * doc above. `request_user_data: false` — we never want WorkDrive collecting the
   * recipient's name/email before letting them view the file (architecture.md §0/§4:
   * delivery is already gated by DMARC + the request token; a second identity gate on
   * Zoho's side would just add friction with no security value here).
   */
  async createPublicLink(
    resourceId: string,
    opts: { allowDownload: boolean },
  ): Promise<{ linkId: string; url: string; embedToken: string }> {
    const url = `${this.config.apiBase}/links`;
    const body = JSON.stringify({
      data: {
        type: 'links',
        attributes: {
          resource_id: resourceId,
          link_name: 'Swenlly share',
          allow_download: opts.allowDownload,
          request_user_data: false,
          role_id: this.config.linkRoleId,
        },
      },
    });
    const json = await this.zohoRequest<ZohoLinkResponse>('POST', url, {
      body,
      extraHeaders: { 'content-type': 'application/vnd.api+json' },
    });
    const linkId = json.data?.id;
    const attrs = json.data?.attributes ?? {};
    const linkUrl = attrs.link ?? attrs.url;
    if (!linkId || !linkUrl) {
      throw new PermanentError('Zoho create-link response missing an id or url');
    }
    const embedToken = extractOrDeriveEmbedToken(attrs, linkUrl);
    return { linkId, url: linkUrl, embedToken };
  }

  /** @unverified-live */
  async revokeLink(linkId: string): Promise<void> {
    const url = `${this.config.apiBase}/links/${encodeURIComponent(linkId)}`;
    await this.zohoRequest('DELETE', url, { extraHeaders: { accept: 'application/vnd.api+json' } });
  }

  /** @unverified-live */
  async openDownload(resourceId: string): Promise<Readable> {
    const token = await this.getAccessToken();
    const url = `${this.config.apiBase}/download/${encodeURIComponent(resourceId)}`;
    let res;
    try {
      res = await request(url, {
        method: 'GET',
        headers: { authorization: `Zoho-oauthtoken ${token}` },
      });
    } catch (err) {
      throw new TransientError('network error opening Zoho download stream', { cause: err });
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const json = await readJsonBody(res);
      throw classifyZohoError(res.statusCode, json);
    }
    return res.body;
  }

  /** @unverified-live */
  async delete(resourceId: string): Promise<void> {
    const url = `${this.config.apiBase}/files/${encodeURIComponent(resourceId)}`;
    await this.zohoRequest('DELETE', url, { extraHeaders: { accept: 'application/vnd.api+json' } });
  }
}

export const __testables = {
  classifyZohoError,
  extractOrDeriveEmbedToken,
  buildMultipartBody,
  chunkStream,
  SIMPLE_UPLOAD_MAX_BYTES,
  ZOHO_CHUNK_SIZE_BYTES,
};

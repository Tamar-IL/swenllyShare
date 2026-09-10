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
  /**
   * Fix pass 5, F-G (`docs/reviews/critic-report.md`): `uploadLargeFile` (below) is a
   * MODELED guess with no field-level confirmation found anywhere reachable — routing a
   * real customer's large file into it silently would be attempting an unverified API
   * call against production data. `false` (the default) makes `upload()` refuse a file
   * over `simpleUploadMaxBytes` with a clear `PermanentError` instead of attempting it;
   * set `true` only once a founder has explicitly accepted that risk, or after spike 1
   * (`docs/runbooks/live-spikes.md`) confirms the shape against a live account.
   */
  largeUploadEnabled?: boolean;
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

/**
 * Fix pass 7 (critic-report.md #6): `ensureFolder`'s response shape — modeled on the
 * SAME JSON:API envelope every other WorkDrive endpoint in this file uses (`data.id` as
 * the created resource's id), since folders and files share the `/files` endpoint on
 * WorkDrive (a folder is a `files` resource with no content). **Unconfirmed against a
 * live account** — no field beyond `data.id` is read, so even a materially different
 * `attributes` shape would not break this, but the top-level envelope itself is a guess.
 */
interface ZohoFolderResponse {
  data?: { id?: string };
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

/**
 * Strips `\r`, `\n`, and NUL from a multipart field value (finding #3,
 * docs/security/appsec-review.md): any of the three, unescaped, inside a
 * `Content-Disposition:`/value line lets a caller-controlled string terminate that line
 * early and inject additional header lines or even a fake `--boundary` part — CRLF/
 * boundary injection into the outbound Zoho call. Applied to every field value AND the
 * file-part filename (not just the filename, which is all the code previously covered);
 * quotes are also stripped from the filename since it is the one value placed inside a
 * quoted attribute. The random 128-bit boundary (`randomBytes(16)`) remains a second
 * layer of defense — unguessable, so even an unstripped value can't deliberately forge
 * it — but this fix means correctness no longer depends on that alone. */
function sanitizeMultipartValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
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
  const sanitizedFilename = sanitizeMultipartValue(filePart.filename).replace(/["]/g, '_');

  const preamble: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    const sanitizedValue = sanitizeMultipartValue(value);
    preamble.push(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${key}"${CRLF}${CRLF}${sanitizedValue}${CRLF}`,
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
 * field name — else `null`.
 *
 * Fix pass 5, F-E (`docs/reviews/critic-report.md`): this used to fall back to deriving a
 * token from the plain link's OWN trailing path segment when no `embed_url`/`embed_link`
 * field was present. That fallback was never a verified embed token — nothing in
 * search-snippet research confirmed WorkDrive's `POST /links` response ever contains a
 * distinct embed identifier at all (`docs/runbooks/live-spikes.md` spike #1) — and worse,
 * it is provably the WRONG thing to return: the plain link's path segment IS (or is
 * derived from) the raw Zoho public link's own identifying token, so a branded page built
 * from it would embed the exact value AC-U3 exists to keep out of the response entirely.
 * Returning `null` here and refusing to render an iframe for it (`GET /s/:slug`,
 * `src/http/routes/public-share.ts`) is strictly safer than a guess that fails silently
 * open.
 */
function extractEmbedToken(attrs: Record<string, unknown>): string | null {
  const embedCandidate = attrs.embed_url ?? attrs.embed_link;
  if (typeof embedCandidate === 'string') {
    const match = embedCandidate.match(/\/embed\/([^/?#]+)/);
    if (match?.[1]) return match[1];
  }
  return null;
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
 *  - The embed-token extraction is flagged separately (see `extractEmbedToken`) — fix
 *    pass 5, F-E: returns `null`, never a value derived from the raw link, when no
 *    distinct embed identifier is present in the response.
 */
export class ZohoFileStore implements FileStorePort {
  private tokenCache?: { accessToken: string; expiresAtMs: number };
  // Fix pass 7 (critic-report.md #6, architecture.md §3/§5): in-memory, per-process
  // cache of tenant-folder name -> WorkDrive folder id, so a tenant's second, third, ...
  // upload reuses the same folder instead of re-creating one (`ensureFolder` below) or
  // paying a second round trip. Keyed on the folder NAME (== the caller's `tenantId`,
  // per `FilesService.publishFile`'s call), not the tenant id twice over.
  private readonly tenantFolderCache = new Map<string, string>();

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

  /**
   * @unverified-live
   * Fix pass 8 (code-review.md polish-pass finding 2): best-effort second line of
   * defense behind `FilesService.publishFile`'s DB-persisted-id + advisory-lock
   * mechanism (the PRIMARY de-duplication path — see that method's doc comment) — if a
   * tenant's `tenants.zoho_folder_id` row is ever lost (a manual DB edit, a restore from
   * an older backup, ...) a lookup-by-name here still finds the real existing folder
   * instead of blindly creating a duplicate. MODELED, like `uploadLargeFile` above:
   * WorkDrive's own community-referenced "list a folder's children" endpoint is `GET
   * {apiBase}/files/<parentId>/files`; no live account was reachable to confirm the
   * exact response envelope or whether it supports server-side name filtering, so this
   * fetches the page and filters client-side rather than trusting an unconfirmed query
   * parameter name. Confirm against a live account before relying on it
   * (docs/runbooks/live-spikes.md spike #1).
   */
  private async findFolderByName(parentId: string, name: string): Promise<string | undefined> {
    const url = `${this.config.apiBase}/files/${encodeURIComponent(parentId)}/files`;
    const json = await this.zohoRequest<{
      data?: { id?: string; attributes?: { name?: string; type?: string } }[];
    }>('GET', url);
    const match = json.data?.find(
      (entry) => entry.attributes?.name === name && entry.attributes?.type === 'folder',
    );
    return match?.id;
  }

  /**
   * @unverified-live
   * Fix pass 7 (critic-report.md #6, architecture.md §3/§5): creates (or reuses, via
   * `tenantFolderCache`) one WorkDrive subfolder per tenant, under `ZOHO_TEAM_FOLDER_ID`,
   * named `name` — `POST {apiBase}/files` with a JSON:API `{data: {type: 'files',
   * attributes: {name, parent_id}}}` body, modeled on the SAME envelope shape this file's
   * other endpoints already use (`uploadLargeFile`'s session-init call is the closest
   * sibling). **Unconfirmed against a live account** (`docs/runbooks/live-spikes.md`
   * spike #1 should record whether this shape is right) — if it turns out folders need a
   * distinct `type` value or a different endpoint entirely, this is the one place to fix
   * it; every caller only ever sees a `folderId` string back.
   *
   * Fix pass 8 (finding 2): now public (part of `FileStorePort`, not just an `upload()`
   * internal) and, on a cache miss, tries `findFolderByName` BEFORE creating — see that
   * method's doc comment. The in-memory `tenantFolderCache` remains a fast path only;
   * `FilesService.publishFile` is what makes the DB the source of truth across restarts.
   */
  async ensureFolder(name: string): Promise<string> {
    const cached = this.tenantFolderCache.get(name);
    if (cached) return cached;
    const existing = await this.findFolderByName(this.config.teamFolderId, name);
    if (existing) {
      this.tenantFolderCache.set(name, existing);
      return existing;
    }
    const url = `${this.config.apiBase}/files`;
    const body = JSON.stringify({
      data: { type: 'files', attributes: { name, parent_id: this.config.teamFolderId } },
    });
    const json = await this.zohoRequest<ZohoFolderResponse>('POST', url, {
      body,
      extraHeaders: { 'content-type': 'application/vnd.api+json' },
    });
    const folderId = json.data?.id;
    if (!folderId) {
      throw new PermanentError('Zoho ensure-folder response contained no folder id');
    }
    this.tenantFolderCache.set(name, folderId);
    return folderId;
  }

  /** Fix pass 8 (finding 2): see `FileStorePort.primeFolder`'s doc comment. */
  primeFolder(name: string, folderId: string): void {
    this.tenantFolderCache.set(name, folderId);
  }

  /** @unverified-live */
  async upload(
    tenantFolder: string,
    stream: Readable,
    sizeBytes: number,
    name: string,
  ): Promise<{ resourceId: string }> {
    const threshold = this.config.simpleUploadMaxBytes ?? SIMPLE_UPLOAD_MAX_BYTES;
    // Fix pass 5, F-G: refuse the unverified large-file path unless explicitly enabled —
    // see `ZohoFileStoreConfig.largeUploadEnabled`'s doc comment. A clear, immediate
    // `PermanentError` (dead-letters `file.publish` with a sender-visible "upload failed"
    // rather than burning the job's retry budget against an endpoint shape nobody has
    // confirmed) is strictly better than silently attempting it against production data.
    // Fix pass 7 (#6): checked BEFORE `ensureFolder` below, so a refused upload still
    // attempts ZERO requests, not one (the folder lookup/creation) — preserving F-G's
    // exact invariant now that a second network call sits in front of every upload.
    if (sizeBytes > threshold && !this.config.largeUploadEnabled) {
      throw new PermanentError(
        `Zoho large-file upload path (>${threshold} bytes) is disabled ` +
          '(ZOHO_LARGE_UPLOAD_ENABLED=false) — its request/response shape is an unverified ' +
          "guess (see uploadLargeFile's doc comment); confirm it against a live account " +
          '(docs/runbooks/live-spikes.md spike #1) before enabling it.',
      );
    }
    // Fix pass 7 (critic-report.md #6): every upload used to land directly in
    // `ZOHO_TEAM_FOLDER_ID` regardless of `tenantFolder` (== the caller's `tenantId`,
    // per `FilesService.publishFile`) — no per-tenant isolation existed in the Zoho half
    // of the storage layer despite architecture.md §3/§5 requiring it. `ensureFolder`
    // resolves (or creates, once, then caches) that tenant's own subfolder; every upload
    // for this tenant lands under it instead of the shared team root.
    const parentId = await this.ensureFolder(tenantFolder);
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
  ): Promise<{ linkId: string; url: string; embedToken: string | null }> {
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
    const embedToken = extractEmbedToken(attrs);
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
  extractEmbedToken,
  buildMultipartBody,
  sanitizeMultipartValue,
  chunkStream,
  SIMPLE_UPLOAD_MAX_BYTES,
  ZOHO_CHUNK_SIZE_BYTES,
};

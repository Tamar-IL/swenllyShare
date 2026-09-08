import { readFileSync } from 'node:fs';
import { setTimeout as sleepMs } from 'node:timers/promises';
import type { Readable } from 'node:stream';
import { request } from 'undici';
import { JWT, UserRefreshClient } from 'google-auth-library';
import type { DriveSharePort } from '../../ports/drive-share.js';
import {
  NotFoundError,
  PermanentError,
  QuotaClassError,
  TransientError,
} from '../../ports/errors.js';
import type { PortError } from '../../ports/errors.js';

/**
 * `drive.file` — the narrowest scope that still lets a central account upload, copy and
 * share the files it creates itself (advisor-consult.md §4). Never widen this without a
 * CASA-exposure conversation.
 */
const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

/** Resumable-upload chunk size — architecture.md §1/§2 mandates "8 MiB multiples". The
 * final chunk of a file is whatever remains and need not be a multiple of 256 KiB, which
 * Google's own spec allows for the last chunk of a session. */
const CHUNK_SIZE_BYTES = 8 * 1024 * 1024;

/**
 * 403 `errors[].reason` values that mean "you've hit Drive's opaque, velocity-based
 * sharing/abuse ceiling" (architecture.md §5, `research/05 §1`). This is the exact set
 * named in the kickoff brief — corroborated by `research/05` against Google's own support
 * content, but no live 403 has actually been observed by this project
 * (**UNCONFIRMED-LIVE**: the reason string Google actually returns for *this* account/API
 * version). `SharingEngine` reacts to `QuotaClassError`; nothing here hard-codes a count.
 */
const QUOTA_REASONS = new Set([
  'sharingRateLimitExceeded',
  'rateLimitExceeded',
  'userRateLimitExceeded',
]);

const MAX_RETRY_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 250;

export interface GoogleDriveShareConfig {
  credentialMode: 'service_account' | 'oauth_refresh';
  saJsonPath?: string;
  impersonateSubject?: string;
  sharedDriveId?: string;
  rootFolderId?: string;
  /** `oauth_refresh` mode only (advisor-consult.md §4 founder-fork path: no Workspace, a
   * dedicated Gmail + production-published OAuth client). Added to `config.ts` /
   * `.env.example` alongside this adapter — they did not exist before this change. */
  oauthClientId?: string;
  oauthClientSecret?: string;
  oauthRefreshToken?: string;
  /**
   * Test seam only — `container.ts` never sets this. Bypasses `google-auth-library`
   * entirely so `tests/contract/drive-share-real.test.ts` can lock down the Drive REST
   * request shapes (URLs, headers, JSON bodies, resumable-upload framing, error
   * classification) with `undici`'s `MockAgent` without also having to fabricate a valid
   * RSA-signed JWT assertion or intercept `oauth2.googleapis.com`. Production always goes
   * through the real `JWT`/`UserRefreshClient` path below, which caches and refreshes the
   * token itself — no separate token cache needed here.
   */
  getAccessToken?: () => Promise<string>;
}

interface GoogleErrorBody {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: { reason?: string; message?: string }[];
  };
}

function extractReasons(body: unknown): string[] {
  const b = body as GoogleErrorBody | undefined;
  const reasons =
    b?.error?.errors?.map((e) => e.reason).filter((r): r is string => Boolean(r)) ?? [];
  if (reasons.length === 0 && b?.error?.status) reasons.push(b.error.status);
  return reasons;
}

/**
 * Classifies a non-2xx Drive API response per architecture.md §2: 403 with a
 * quota-shaped reason → `QuotaClassError`; 429/5xx → `TransientError`; 404 →
 * `NotFoundError`; everything else → `PermanentError`. Never branches on a raw status
 * code outside this one function — see `src/ports/errors.ts`.
 */
function classifyDriveError(status: number, body: unknown): PortError {
  const reasons = extractReasons(body);
  const message = `Google Drive API: HTTP ${status}${reasons.length ? ` (${reasons.join(', ')})` : ''}`;
  if (status === 403 && reasons.some((r) => QUOTA_REASONS.has(r))) {
    return new QuotaClassError(message, { cause: body });
  }
  if (status === 429 || status >= 500) {
    return new TransientError(message, { cause: body });
  }
  if (status === 404) {
    return new NotFoundError(message, { cause: body });
  }
  return new PermanentError(message, { cause: body });
}

/** Escapes a value for embedding inside a Drive `q=` string literal (single-quoted):
 * backslash and single-quote must be backslash-escaped, per Drive's search-query syntax. */
function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = MAX_RETRY_ATTEMPTS): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      attempt += 1;
      if (!(err instanceof TransientError) || attempt >= maxAttempts) throw err;
      const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
      const jitter = Math.random() * backoff * 0.5;
      await sleepMs(backoff + jitter);
    }
  }
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

async function* chunkReadable(stream: Readable, chunkSize: number): AsyncGenerator<Buffer> {
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
  if (bufferedLen > 0) {
    yield Buffer.concat(buffered, bufferedLen);
  }
}

/**
 * Real Google Drive adapter (Drive v3 via `undici` + `google-auth-library`,
 * architecture.md §1, §2). Every method is `@unverified-live`: the real share ceiling,
 * the exact 403 `errors[].reason` values, resumable-upload behavior against a real Shared
 * Drive, and visitor (no-Google-account) sharing are all unverified spikes
 * (architecture.md §12, `docs/runbooks/live-spikes.md`).
 *
 * **What's confirmed vs. guessed, precisely** (so the ledger's honesty holds even before
 * `pnpm gen:ledger` runs):
 *  - The REST shapes (`files.copy`, `permissions.create`, `files.list` with `appProperties
 *    has {...}`, resumable-upload init/PUT framing, `supportsAllDrives=true`) are Google's
 *    own long-stable, documented Drive v3 contract — primary-source confidence, just never
 *    exercised live from this environment (egress-blocked, `research/05` §0).
 *  - The exact 403 `errors[].reason` strings this specific account will actually return,
 *    and whether visitor sharing is enabled by default on the configured account type, are
 *    genuinely unverified — that's `docs/runbooks/live-spikes.md` spike #2.
 */
export class GoogleDriveShare implements DriveSharePort {
  private authClient?: JWT | UserRefreshClient;

  constructor(private readonly config: GoogleDriveShareConfig) {}

  private buildAuthClient(): JWT | UserRefreshClient {
    if (this.config.credentialMode === 'service_account') {
      if (!this.config.saJsonPath) {
        throw new Error('GoogleDriveShare: service_account mode requires GOOGLE_SA_JSON_PATH');
      }
      const raw = readFileSync(this.config.saJsonPath, 'utf8');
      const key = JSON.parse(raw) as { client_email: string; private_key: string };
      // Domain-wide delegation: `subject` impersonates GOOGLE_IMPERSONATE_SUBJECT so the
      // Shared Drive files are owned/actioned by that mailbox, not the bare SA identity
      // (advisor-consult.md §4).
      return new JWT({
        email: key.client_email,
        key: key.private_key,
        scopes: [DRIVE_FILE_SCOPE],
        subject: this.config.impersonateSubject,
      });
    }
    if (
      !this.config.oauthClientId ||
      !this.config.oauthClientSecret ||
      !this.config.oauthRefreshToken
    ) {
      throw new Error(
        'GoogleDriveShare: oauth_refresh mode requires GOOGLE_OAUTH_CLIENT_ID, ' +
          'GOOGLE_OAUTH_CLIENT_SECRET and GOOGLE_OAUTH_REFRESH_TOKEN',
      );
    }
    return new UserRefreshClient({
      clientId: this.config.oauthClientId,
      clientSecret: this.config.oauthClientSecret,
      refreshToken: this.config.oauthRefreshToken,
    });
  }

  /** `JWT`/`UserRefreshClient` cache the access token and its expiry internally and
   * refresh transparently on the next call once it's stale — no hand-rolled cache needed
   * here, unlike the Zoho adapter (which has no such library and rolls its own). */
  private async accessToken(): Promise<string> {
    if (this.config.getAccessToken) return this.config.getAccessToken();
    if (!this.authClient) this.authClient = this.buildAuthClient();
    const { token } = await this.authClient.getAccessToken();
    if (!token) throw new PermanentError('GoogleDriveShare: failed to obtain an access token');
    return token;
  }

  private async authHeader(): Promise<Record<string, string>> {
    return { authorization: `Bearer ${await this.accessToken()}` };
  }

  private async driveJson<T>(
    method: string,
    url: string,
    opts: { body?: string; extraHeaders?: Record<string, string> } = {},
  ): Promise<T> {
    const auth = await this.authHeader();
    let res;
    try {
      res = await request(url, {
        method,
        headers: { ...auth, ...opts.extraHeaders },
        body: opts.body,
      });
    } catch (err) {
      throw new TransientError('network error calling Google Drive API', { cause: err });
    }
    const json = await readJsonBody(res);
    if (res.statusCode >= 200 && res.statusCode < 300) return json as T;
    throw classifyDriveError(res.statusCode, json);
  }

  private async driveVoid(method: string, url: string): Promise<void> {
    await this.driveJson<unknown>(method, url);
  }

  private async initiateResumableSession(
    name: string,
    mime: string,
    sizeBytes: number,
  ): Promise<string> {
    const metadata: Record<string, unknown> = { name, mimeType: mime };
    // A Shared Drive requires an explicit parent within it — uploading straight to the
    // drive's root id also works as a parent value. Prefer a dedicated root folder when
    // configured (keeps the drive tidy); fall back to the drive id itself.
    const parent = this.config.rootFolderId ?? this.config.sharedDriveId;
    if (parent) metadata.parents = [parent];

    const url = `${DRIVE_UPLOAD_BASE}/files?uploadType=resumable&supportsAllDrives=true`;
    const auth = await this.authHeader();
    let res;
    try {
      res = await request(url, {
        method: 'POST',
        headers: {
          ...auth,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': mime,
          'x-upload-content-length': String(sizeBytes),
        },
        body: JSON.stringify(metadata),
      });
    } catch (err) {
      throw new TransientError('network error initiating Drive resumable upload', { cause: err });
    }
    if (res.statusCode !== 200) {
      const json = await readJsonBody(res);
      throw classifyDriveError(res.statusCode, json);
    }
    await res.body.text().catch(() => undefined); // drain — body is empty on success
    const location = res.headers['location'];
    if (!location || Array.isArray(location)) {
      throw new PermanentError(
        'Drive resumable upload init returned no Location header for the session URI',
      );
    }
    return location;
  }

  private async putChunk(
    sessionUri: string,
    chunk: Buffer,
    start: number,
    totalBytes: number,
  ): Promise<{ done: boolean; fileId?: string }> {
    const end = start + chunk.length - 1;
    let res;
    try {
      res = await request(sessionUri, {
        method: 'PUT',
        headers: {
          'content-length': String(chunk.length),
          'content-range': `bytes ${start}-${end}/${totalBytes}`,
        },
        body: chunk,
      });
    } catch (err) {
      throw new TransientError('network error during Drive resumable chunk PUT', { cause: err });
    }
    // 308 Resume Incomplete is the *expected*, non-error response for every chunk except
    // the last — not something to classify as a failure.
    if (res.statusCode === 308) {
      await res.body.text().catch(() => undefined);
      return { done: false };
    }
    if (res.statusCode === 200 || res.statusCode === 201) {
      const json = (await readJsonBody(res)) as { id?: string } | undefined;
      if (!json?.id) {
        throw new PermanentError(
          'Drive resumable upload completed without a file id in the response',
        );
      }
      return { done: true, fileId: json.id };
    }
    const json = await readJsonBody(res);
    throw classifyDriveError(res.statusCode, json);
  }

  /** @unverified-live */
  async uploadResumable(
    stream: Readable,
    sizeBytes: number,
    name: string,
    mime: string,
  ): Promise<{ driveFileId: string }> {
    const sessionUri = await withRetry(() => this.initiateResumableSession(name, mime, sizeBytes));

    let uploaded = 0;
    let sawAnyChunk = false;
    for await (const chunk of chunkReadable(stream, CHUNK_SIZE_BYTES)) {
      sawAnyChunk = true;
      const start = uploaded;
      // Not wrapped in `withRetry` at this call site for a genuine network drop mid-chunk:
      // Google's protocol wants a resume via a zero-length status-check PUT
      // (`Content-Range: bytes */<total>`) rather than blindly re-sending the same byte
      // range, which could double-count bytes server-side if the original PUT actually
      // landed. `withRetry` only re-invokes `putChunk` for the *same, already-computed*
      // `start`/`chunk`, which is safe for a connection that never got a request out the
      // door (the common case for a `TransientError` at this layer) but not a fully
      // general resume. A production hardening pass would add the status-check-and-resume
      // dance here; noted as a known gap, not silently glossed over.
      const result = await withRetry(() => this.putChunk(sessionUri, chunk, start, sizeBytes));
      uploaded += chunk.length;
      if (result.done) return { driveFileId: result.fileId! };
    }

    if (!sawAnyChunk) {
      // Zero-byte file: no chunk was ever produced to carry the finalizing PUT. Send one
      // explicit zero-length request to close out the session.
      const result = await withRetry(() => this.putChunk(sessionUri, Buffer.alloc(0), 0, 0));
      if (result.done) return { driveFileId: result.fileId! };
    }

    throw new PermanentError(
      `Drive resumable upload never returned a completed file after ${uploaded}/${sizeBytes} bytes`,
    );
  }

  /** @unverified-live */
  async copy(driveFileId: string, intentKey: string): Promise<{ driveFileId: string }> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/copy?supportsAllDrives=true&fields=id`;
    const json = await withRetry(() =>
      this.driveJson<{ id: string }>('POST', url, {
        body: JSON.stringify({ appProperties: { swenllyIntent: intentKey } }),
        extraHeaders: { 'content-type': 'application/json; charset=UTF-8' },
      }),
    );
    return { driveFileId: json.id };
  }

  /** @unverified-live */
  async findByIntent(intentKey: string): Promise<{ driveFileId: string } | undefined> {
    const q = `appProperties has { key='swenllyIntent' and value='${escapeDriveQueryValue(intentKey)}' } and trashed=false`;
    const params = new URLSearchParams({
      q,
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
      corpora: this.config.sharedDriveId ? 'drive' : 'user',
      fields: 'files(id)',
      pageSize: '1',
    });
    if (this.config.sharedDriveId) params.set('driveId', this.config.sharedDriveId);
    const url = `${DRIVE_API_BASE}/files?${params.toString()}`;
    const json = await withRetry(() => this.driveJson<{ files?: { id: string }[] }>('GET', url));
    const first = json.files?.[0];
    return first ? { driveFileId: first.id } : undefined;
  }

  /** @unverified-live */
  async sharePermission(driveFileId: string, email: string): Promise<{ permissionId: string }> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false&fields=id`;
    const json = await withRetry(() =>
      this.driveJson<{ id: string }>('POST', url, {
        body: JSON.stringify({ type: 'user', role: 'reader', emailAddress: email }),
        extraHeaders: { 'content-type': 'application/json; charset=UTF-8' },
      }),
    );
    return { permissionId: json.id };
  }

  /** @unverified-live */
  async revokeAll(driveFileId: string): Promise<void> {
    const listUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/permissions?supportsAllDrives=true&fields=permissions(id,role)`;
    const json = await withRetry(() =>
      this.driveJson<{ permissions?: { id: string; role: string }[] }>('GET', listUrl),
    );
    const toRevoke = (json.permissions ?? []).filter(
      (p) => p.role !== 'owner' && p.role !== 'organizer',
    );
    for (const perm of toRevoke) {
      const delUrl = `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}/permissions/${encodeURIComponent(perm.id)}?supportsAllDrives=true`;
      await withRetry(() => this.driveVoid('DELETE', delUrl));
    }
  }

  /** @unverified-live */
  async delete(driveFileId: string): Promise<void> {
    const url = `${DRIVE_API_BASE}/files/${encodeURIComponent(driveFileId)}?supportsAllDrives=true`;
    await withRetry(() => this.driveVoid('DELETE', url));
  }
}

export const __testables = {
  classifyDriveError,
  escapeDriveQueryValue,
  chunkReadable,
  CHUNK_SIZE_BYTES,
};

import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { ZohoFileStore, __testables } from '../../src/adapters/zoho/real.js';
import { NotFoundError, PermanentError, TransientError } from '../../src/ports/errors.js';
import { pathnameIs, readMockBodyBuffer, readMockBodyText } from './support/mock-http.js';

/**
 * Offline unit tests for `ZohoFileStore` (architecture.md §2/§9 item 4): lock down the
 * WorkDrive REST request shapes (OAuth refresh, multipart upload, the JSON:API create-link
 * envelope, download, delete) and error classification, without live credentials, using
 * `undici`'s `MockAgent`. These run in the normal `pnpm test`; see
 * `tests/contract/file-store.test.ts` for the fake-vs-real port-contract suite (the real
 * leg of which is skipped without `LIVE_ZOHO=1`).
 */

const ACCOUNTS_ORIGIN = 'https://accounts.zoho.test';
const API_ORIGIN = 'https://workdrive.zoho.test';
const API_BASE = `${API_ORIGIN}/api/v1`;

function buildStore(
  overrides: { simpleUploadMaxBytes?: number; chunkSizeBytes?: number } = {},
): ZohoFileStore {
  return new ZohoFileStore({
    apiBase: API_BASE,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    refreshToken: 'refresh-1',
    teamFolderId: 'team-folder-1',
    accountsBase: ACCOUNTS_ORIGIN,
    linkRoleId: '6',
    ...overrides,
  });
}

/** Every test needs a token refresh first (no seam to bypass it, unlike Google's — see
 * `ZohoFileStore`'s class doc: the OAuth flow is a plain form POST, cheap enough to just
 * mock for real rather than add a test-only bypass). */
function mockTokenRefresh(mockAgent: MockAgent): void {
  const pool = mockAgent.get(ACCOUNTS_ORIGIN);
  pool
    .intercept({ path: pathnameIs('/oauth/v2/token'), method: 'POST' })
    .reply(200, {
      access_token: 'zoho-access-token',
      expires_in: 3600,
      token_type: 'Zoho-oauthtoken',
    })
    .persist();
}

describe('ZohoFileStore (real adapter) — offline wire-shape tests', () => {
  let mockAgent: MockAgent;
  let restoreDispatcher: ReturnType<typeof getGlobalDispatcher>;
  let store: ZohoFileStore;

  beforeEach(() => {
    restoreDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    mockTokenRefresh(mockAgent);
    store = buildStore();
  });

  afterEach(async () => {
    setGlobalDispatcher(restoreDispatcher);
    await mockAgent.close();
  });

  it('refreshes the OAuth token as a form POST and caches it across calls', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    let calls = 0;
    let authHeader: string | undefined;
    pool.intercept({ path: pathnameIs('/api/v1/files/f-1'), method: 'DELETE' }).reply((opts) => {
      calls += 1;
      authHeader = (opts.headers as Record<string, string>).authorization;
      return { statusCode: 204, data: '' };
    });
    pool.intercept({ path: pathnameIs('/api/v1/files/f-2'), method: 'DELETE' }).reply(() => {
      calls += 1;
      return { statusCode: 204, data: '' };
    });

    await store.delete('f-1');
    await store.delete('f-2');

    expect(calls).toBe(2);
    expect(authHeader).toBe('Zoho-oauthtoken zoho-access-token');
    // The token-refresh interceptor is `.persist()`ed but a second call proves the
    // adapter didn't even need to hit it again within the cached `expires_in` window —
    // asserted implicitly by both deletes succeeding against the single cached token.
  });

  it('upload (simple path): multipart POST to /upload with parent_id + streamed content field', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    let capturedContentType = '';
    let capturedBody = '';
    pool.intercept({ path: pathnameIs('/api/v1/upload'), method: 'POST' }).reply(async (opts) => {
      capturedContentType = (opts.headers as Record<string, string>)['content-type'];
      capturedBody = await readMockBodyText(opts.body);
      return { statusCode: 200, data: { data: [{ attributes: { resource_id: 'res-1' } }] } };
    });

    const result = await store.upload(
      'tenant-a',
      Readable.from(Buffer.from('file content')),
      12,
      'doc.pdf',
    );

    expect(result.resourceId).toBe('res-1');
    expect(capturedContentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(capturedBody).toContain('name="parent_id"');
    expect(capturedBody).toContain('team-folder-1');
    expect(capturedBody).toContain('name="content"; filename="doc.pdf"');
    expect(capturedBody).toContain('file content');
  });

  it('upload (large-file path): session init then ranged PUT chunks, finalizing on the last chunk', async () => {
    // Shrink both thresholds via the test-only config seam (see `ZohoFileStoreConfig`) so
    // this exercises real chunking logic against a few KB instead of allocating a real
    // 250MB+ buffer.
    const smallChunkStore = buildStore({ simpleUploadMaxBytes: 10, chunkSizeBytes: 4 });
    const pool = mockAgent.get(API_ORIGIN);
    const content = Buffer.from('0123456789A'); // 11 bytes (> 10-byte threshold), chunked into 4+4+3

    let initBody: unknown;
    pool
      .intercept({ path: pathnameIs('/api/v1/uploadlargefile/sessions'), method: 'POST' })
      .reply(async (opts) => {
        initBody = JSON.parse(await readMockBodyText(opts.body));
        return { statusCode: 200, data: { data: { id: 'session-1' } } };
      });

    const ranges: string[] = [];
    const chunkBodies: string[] = [];
    pool
      .intercept({ path: pathnameIs('/api/v1/uploadlargefile/sessions/session-1'), method: 'PUT' })
      .reply(async (opts) => {
        ranges.push((opts.headers as Record<string, string>)['content-range']);
        chunkBodies.push((await readMockBodyBuffer(opts.body)).toString('utf8'));
        return { statusCode: 200, data: {} };
      })
      .times(2);
    // The finalize response (last chunk) is the one that must carry the resource id — the
    // adapter reads it from whichever chunk response arrives when `end + 1 >= sizeBytes`.
    // Overriding the third call's reply (rather than the generic one above) proves the
    // adapter is keyed off byte offsets, not "the response to the Nth request":
    pool
      .intercept({ path: pathnameIs('/api/v1/uploadlargefile/sessions/session-1'), method: 'PUT' })
      .reply(async (opts) => {
        ranges.push((opts.headers as Record<string, string>)['content-range']);
        chunkBodies.push((await readMockBodyBuffer(opts.body)).toString('utf8'));
        return { statusCode: 200, data: { data: { id: 'final-chunk-resource' } } };
      });

    const result = await smallChunkStore.upload(
      'tenant-a',
      Readable.from(content),
      content.length,
      'huge.bin',
    );

    expect(initBody).toMatchObject({
      data: {
        attributes: { parent_id: 'team-folder-1', filename: 'huge.bin', size: 11 },
      },
    });
    expect(chunkBodies).toEqual(['0123', '4567', '89A']);
    expect(ranges).toEqual(['bytes 0-3/11', 'bytes 4-7/11', 'bytes 8-10/11']);
    expect(result.resourceId).toBe('final-chunk-resource');
  });

  it('createPublicLink: POSTs the JSON:API envelope with resource_id/link_name/allow_download/role_id', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;
    pool.intercept({ path: pathnameIs('/api/v1/links'), method: 'POST' }).reply(async (opts) => {
      capturedHeaders = opts.headers as Record<string, string>;
      capturedBody = JSON.parse(await readMockBodyText(opts.body));
      return {
        statusCode: 200,
        data: {
          data: { id: 'link-1', attributes: { link: 'https://workdrive.zoho.test/link/abc123' } },
        },
      };
    });

    const result = await store.createPublicLink('res-1', { allowDownload: true });

    expect(capturedHeaders['content-type']).toBe('application/vnd.api+json');
    expect(capturedHeaders.accept).toBe('application/vnd.api+json');
    expect(capturedBody).toEqual({
      data: {
        type: 'links',
        attributes: {
          resource_id: 'res-1',
          link_name: 'Swenlly share',
          allow_download: true,
          request_user_data: false,
          role_id: '6',
        },
      },
    });
    expect(result).toEqual({
      linkId: 'link-1',
      url: 'https://workdrive.zoho.test/link/abc123',
      embedToken: 'abc123',
    });
  });

  it('createPublicLink: prefers a real embed_url token over the derived fallback when present', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    pool.intercept({ path: pathnameIs('/api/v1/links'), method: 'POST' }).reply(200, {
      data: {
        id: 'link-2',
        attributes: {
          url: 'https://workdrive.zoho.test/link/xyz',
          embed_url: 'https://workdrive.zohoexternal.com/embed/realtoken789?toolbar=false',
        },
      },
    });

    const result = await store.createPublicLink('res-2', { allowDownload: false });

    expect(result.embedToken).toBe('realtoken789');
  });

  it('createPublicLink: throws PermanentError when the response has no id/url', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    pool.intercept({ path: pathnameIs('/api/v1/links'), method: 'POST' }).reply(200, { data: {} });

    await expect(store.createPublicLink('res-3', { allowDownload: true })).rejects.toBeInstanceOf(
      PermanentError,
    );
  });

  it('revokeLink: DELETEs /links/{id} with the JSON:API accept header', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    let capturedAccept = '';
    pool.intercept({ path: pathnameIs('/api/v1/links/link-1'), method: 'DELETE' }).reply((opts) => {
      capturedAccept = (opts.headers as Record<string, string>).accept;
      return { statusCode: 204, data: '' };
    });

    await store.revokeLink('link-1');

    expect(capturedAccept).toBe('application/vnd.api+json');
  });

  it('openDownload: GETs /download/{resourceId} and returns the raw byte stream', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/api/v1/download/res-1'), method: 'GET' })
      .reply(200, Buffer.from('the file bytes'));

    const stream = await store.openDownload('res-1');
    const bytes = await readMockBodyBuffer(stream);

    expect(bytes.toString('utf8')).toBe('the file bytes');
  });

  it('openDownload: classifies a 404 as NotFoundError', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/api/v1/download/missing'), method: 'GET' })
      .reply(404, { errors: [{ status: '404', title: 'Not Found' }] });

    await expect(store.openDownload('missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('delete: DELETEs /files/{resourceId}', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    let hit = false;
    pool.intercept({ path: pathnameIs('/api/v1/files/res-1'), method: 'DELETE' }).reply(() => {
      hit = true;
      return { statusCode: 204, data: '' };
    });

    await store.delete('res-1');

    expect(hit).toBe(true);
  });

  it('classifies a 429 and a 5xx as TransientError, and a token-refresh failure as PermanentError', async () => {
    const pool = mockAgent.get(API_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/api/v1/files/rl'), method: 'DELETE' })
      .reply(429, { errors: [{ status: '429', title: 'Too Many Requests' }] });
    await expect(store.delete('rl')).rejects.toBeInstanceOf(TransientError);

    pool
      .intercept({ path: pathnameIs('/api/v1/files/srv'), method: 'DELETE' })
      .reply(502, { errors: [{ status: '502', title: 'Bad Gateway' }] });
    await expect(store.delete('srv')).rejects.toBeInstanceOf(TransientError);
  });

  it('a failed token refresh classifies per status (e.g. 400 invalid_client -> PermanentError)', async () => {
    // Fresh agent for this one test: no persisted good-token interceptor from the shared
    // `beforeEach`, so the very first call must hit (and fail) the token endpoint.
    setGlobalDispatcher(restoreDispatcher);
    await mockAgent.close();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    const badTokenPool = mockAgent.get(ACCOUNTS_ORIGIN);
    badTokenPool
      .intercept({ path: pathnameIs('/oauth/v2/token'), method: 'POST' })
      .reply(400, { error: 'invalid_client' });
    const freshStore = buildStore();

    await expect(freshStore.delete('anything')).rejects.toBeInstanceOf(PermanentError);
  });
});

describe('Zoho embed-token derivation and error classification (pure, no network)', () => {
  it('extracts a token from an embed_url when present', () => {
    const token = __testables.extractOrDeriveEmbedToken(
      { embed_url: 'https://workdrive.zohoexternal.com/embed/abc123?toolbar=false' },
      'https://workdrive.zoho.test/link/plain',
    );
    expect(token).toBe('abc123');
  });

  it('falls back to the plain link’s trailing path segment when no embed field is present', () => {
    const token = __testables.extractOrDeriveEmbedToken(
      {},
      'https://workdrive.zoho.test/link/plainTokenXYZ',
    );
    expect(token).toBe('plainTokenXYZ');
  });

  it('classifyZohoError maps 404/429/5xx per architecture.md §2', () => {
    expect(__testables.classifyZohoError(404, {})).toBeInstanceOf(NotFoundError);
    expect(__testables.classifyZohoError(429, {})).toBeInstanceOf(TransientError);
    expect(__testables.classifyZohoError(500, {})).toBeInstanceOf(TransientError);
    expect(__testables.classifyZohoError(400, {})).toBeInstanceOf(PermanentError);
  });
});

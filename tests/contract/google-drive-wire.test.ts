import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { GoogleDriveShare, __testables } from '../../src/adapters/google/real.js';
import { NotFoundError, QuotaClassError, TransientError } from '../../src/ports/errors.js';
import { mockUrl, pathnameIs, readMockBodyBuffer, readMockBodyText } from './support/mock-http.js';

/**
 * Offline unit tests for `GoogleDriveShare` (architecture.md §2/§9 item 4): lock down the
 * Drive REST request shapes — URLs, headers, JSON bodies, resumable-upload chunk framing,
 * and error classification — without any live credentials, using `undici`'s `MockAgent`
 * against the real adapter code. These run in the normal `pnpm test`; see
 * `tests/contract/drive-share.test.ts` for the fake-vs-real port-contract suite (the real
 * leg of which is skipped without `LIVE_GOOGLE=1`).
 */

const GOOGLE_ORIGIN = 'https://www.googleapis.com';
const { CHUNK_SIZE_BYTES } = __testables;

describe('GoogleDriveShare (real adapter) — offline wire-shape tests', () => {
  let mockAgent: MockAgent;
  let restoreDispatcher: ReturnType<typeof getGlobalDispatcher>;
  let drive: GoogleDriveShare;

  beforeEach(() => {
    restoreDispatcher = getGlobalDispatcher();
    mockAgent = new MockAgent();
    mockAgent.disableNetConnect();
    setGlobalDispatcher(mockAgent);
    drive = new GoogleDriveShare({
      credentialMode: 'service_account',
      sharedDriveId: 'shared-drive-1',
      rootFolderId: 'root-folder-1',
      getAccessToken: async () => 'test-access-token',
    });
  });

  afterEach(async () => {
    setGlobalDispatcher(restoreDispatcher);
    await mockAgent.close();
  });

  it('uploadResumable: initiates a session with the documented headers/body, chunks in 8 MiB pieces, and follows 308 to a final 200', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    const sizeBytes = CHUNK_SIZE_BYTES + 10;
    const content = Buffer.alloc(sizeBytes, 7);

    let initAuth: string | undefined;
    let initHeaders: Record<string, string> = {};
    let initBody: unknown;
    pool
      .intercept({ path: pathnameIs('/upload/drive/v3/files'), method: 'POST' })
      .reply(async (opts) => {
        const url = mockUrl(opts.path);
        expect(url.searchParams.get('uploadType')).toBe('resumable');
        expect(url.searchParams.get('supportsAllDrives')).toBe('true');
        initHeaders = opts.headers as Record<string, string>;
        initAuth = initHeaders.authorization;
        initBody = JSON.parse(await readMockBodyText(opts.body));
        return {
          statusCode: 200,
          data: '',
          responseOptions: { headers: { location: `${GOOGLE_ORIGIN}/upload/session/xyz` } },
        };
      });

    const contentRanges: string[] = [];
    pool
      .intercept({ path: pathnameIs('/upload/session/xyz'), method: 'PUT' })
      .reply(async (opts) => {
        contentRanges.push((opts.headers as Record<string, string>)['content-range']);
        const body = await readMockBodyBuffer(opts.body);
        expect(body.length).toBe(CHUNK_SIZE_BYTES);
        return {
          statusCode: 308,
          data: '',
          responseOptions: { headers: { range: `bytes=0-${CHUNK_SIZE_BYTES - 1}` } },
        };
      });
    pool
      .intercept({ path: pathnameIs('/upload/session/xyz'), method: 'PUT' })
      .reply(async (opts) => {
        contentRanges.push((opts.headers as Record<string, string>)['content-range']);
        const body = await readMockBodyBuffer(opts.body);
        expect(body.length).toBe(10);
        return { statusCode: 200, data: { id: 'drive-file-1' } };
      });

    const result = await drive.uploadResumable(
      Readable.from(content),
      sizeBytes,
      'big.bin',
      'application/octet-stream',
    );

    expect(result.driveFileId).toBe('drive-file-1');
    expect(initAuth).toBe('Bearer test-access-token');
    expect(initHeaders['x-upload-content-length']).toBe(String(sizeBytes));
    expect(initHeaders['x-upload-content-type']).toBe('application/octet-stream');
    expect(initBody).toMatchObject({
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      parents: ['root-folder-1'],
    });
    expect(contentRanges).toEqual([
      `bytes 0-${CHUNK_SIZE_BYTES - 1}/${sizeBytes}`,
      `bytes ${CHUNK_SIZE_BYTES}-${sizeBytes - 1}/${sizeBytes}`,
    ]);
  });

  it('copy: POSTs to files/{id}/copy with appProperties.swenllyIntent and supportsAllDrives=true', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    let capturedPath = '';
    let capturedBody: unknown;
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/source-1/copy'), method: 'POST' })
      .reply(async (opts) => {
        capturedPath = opts.path;
        capturedBody = JSON.parse(await readMockBodyText(opts.body));
        return { statusCode: 200, data: { id: 'copy-1' } };
      });

    const result = await drive.copy('source-1', 'tenant-a:file-b:0');

    expect(result.driveFileId).toBe('copy-1');
    expect(mockUrl(capturedPath).searchParams.get('supportsAllDrives')).toBe('true');
    expect(capturedBody).toEqual({ appProperties: { swenllyIntent: 'tenant-a:file-b:0' } });
  });

  it('findByIntent: builds an appProperties-has query scoped to the shared drive, and escapes single quotes/backslashes', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    let capturedPath = '';
    pool.intercept({ path: pathnameIs('/drive/v3/files'), method: 'GET' }).reply((opts) => {
      capturedPath = opts.path;
      return { statusCode: 200, data: { files: [{ id: 'found-1' }] } };
    });

    const result = await drive.findByIntent("weird'key\\here");

    expect(result).toEqual({ driveFileId: 'found-1' });
    const url = mockUrl(capturedPath);
    expect(url.searchParams.get('q')).toBe(
      "appProperties has { key='swenllyIntent' and value='weird\\'key\\\\here' } and trashed=false",
    );
    expect(url.searchParams.get('driveId')).toBe('shared-drive-1');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
  });

  it('findByIntent: returns undefined when Drive reports no matching files', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/drive/v3/files'), method: 'GET' })
      .reply(200, { files: [] });

    await expect(drive.findByIntent('none')).resolves.toBeUndefined();
  });

  it('sharePermission: POSTs type=user/role=reader with sendNotificationEmail=false', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    let capturedPath = '';
    let capturedBody: unknown;
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1/permissions'), method: 'POST' })
      .reply(async (opts) => {
        capturedPath = opts.path;
        capturedBody = JSON.parse(await readMockBodyText(opts.body));
        return { statusCode: 200, data: { id: 'perm-1' } };
      });

    const result = await drive.sharePermission('file-1', 'Requester@Example.com');

    expect(result.permissionId).toBe('perm-1');
    const url = mockUrl(capturedPath);
    expect(url.searchParams.get('sendNotificationEmail')).toBe('false');
    expect(url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(capturedBody).toEqual({
      type: 'user',
      role: 'reader',
      emailAddress: 'Requester@Example.com',
    });
  });

  it('sharePermission: classifies a 403 sharingRateLimitExceeded as QuotaClassError', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1/permissions'), method: 'POST' })
      .reply(403, {
        error: { code: 403, errors: [{ reason: 'sharingRateLimitExceeded', message: 'quota' }] },
      });

    await expect(drive.sharePermission('file-1', 'a@b.com')).rejects.toBeInstanceOf(
      QuotaClassError,
    );
  });

  it('classifies a 404 as NotFoundError', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/missing/permissions'), method: 'POST' })
      .reply(404, { error: { code: 404, errors: [{ reason: 'notFound' }] } });

    await expect(drive.sharePermission('missing', 'a@b.com')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('retries a transient 503 and succeeds on the next attempt', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    let attempts = 0;
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1/permissions'), method: 'POST' })
      .reply(() => {
        attempts += 1;
        return { statusCode: 503, data: { error: { code: 503 } } };
      });
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1/permissions'), method: 'POST' })
      .reply(() => {
        attempts += 1;
        return { statusCode: 200, data: { id: 'perm-after-retry' } };
      });

    const result = await drive.sharePermission('file-1', 'a@b.com');

    expect(result.permissionId).toBe('perm-after-retry');
    expect(attempts).toBe(2);
  });

  it('exhausts bounded retries and surfaces TransientError for a persistent 500', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    let attempts = 0;
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1/permissions'), method: 'POST' })
      .reply(() => {
        attempts += 1;
        return { statusCode: 500, data: { error: { code: 500 } } };
      })
      .persist();

    await expect(drive.sharePermission('file-1', 'a@b.com')).rejects.toBeInstanceOf(TransientError);
    expect(attempts).toBeGreaterThan(1);
  }, 15_000);

  it('revokeAll: lists permissions, then DELETEs every non-owner permission', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1/permissions'), method: 'GET' })
      .reply(200, {
        permissions: [
          { id: 'owner-perm', role: 'owner' },
          { id: 'reader-perm-1', role: 'reader' },
          { id: 'reader-perm-2', role: 'reader' },
        ],
      });
    const deleted: string[] = [];
    pool
      .intercept({
        path: pathnameIs('/drive/v3/files/file-1/permissions/reader-perm-1'),
        method: 'DELETE',
      })
      .reply(() => {
        deleted.push('reader-perm-1');
        return { statusCode: 204, data: '' };
      });
    pool
      .intercept({
        path: pathnameIs('/drive/v3/files/file-1/permissions/reader-perm-2'),
        method: 'DELETE',
      })
      .reply(() => {
        deleted.push('reader-perm-2');
        return { statusCode: 204, data: '' };
      });

    await drive.revokeAll('file-1');

    expect(deleted.sort()).toEqual(['reader-perm-1', 'reader-perm-2']);
  });

  it('delete: DELETEs files/{id} with supportsAllDrives=true', async () => {
    const pool = mockAgent.get(GOOGLE_ORIGIN);
    let capturedPath = '';
    pool
      .intercept({ path: pathnameIs('/drive/v3/files/file-1'), method: 'DELETE' })
      .reply((opts) => {
        capturedPath = opts.path;
        return { statusCode: 204, data: '' };
      });

    await drive.delete('file-1');

    expect(mockUrl(capturedPath).searchParams.get('supportsAllDrives')).toBe('true');
  });
});

describe('GoogleDriveShare error classification (pure, no network)', () => {
  it('escapeDriveQueryValue backslash-escapes backslashes and single quotes', () => {
    expect(__testables.escapeDriveQueryValue("a'b\\c")).toBe("a\\'b\\\\c");
  });

  it('classifyDriveError maps status/reason combinations per architecture.md §2', () => {
    expect(
      __testables.classifyDriveError(403, {
        error: { errors: [{ reason: 'rateLimitExceeded' }] },
      }),
    ).toBeInstanceOf(QuotaClassError);
    expect(
      __testables.classifyDriveError(403, { error: { errors: [{ reason: 'forbidden' }] } }),
    ).not.toBeInstanceOf(QuotaClassError);
    expect(__testables.classifyDriveError(429, {})).toBeInstanceOf(TransientError);
    expect(__testables.classifyDriveError(500, {})).toBeInstanceOf(TransientError);
    expect(__testables.classifyDriveError(404, {})).toBeInstanceOf(NotFoundError);
  });
});

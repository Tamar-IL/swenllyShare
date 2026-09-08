import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FileStorePort } from '../../src/ports/file-store.js';
import { FakeFileStore } from '../../src/adapters/zoho/fake.js';
import { ZohoFileStore } from '../../src/adapters/zoho/real.js';

/**
 * `FileStorePort` contract suite, run against both adapters (architecture.md §2, §9 item
 * 4). The `real` leg only runs with `LIVE_ZOHO=1` plus real Zoho credentials — neither is
 * available in this environment, so it reports **skipped, not passed**. See
 * `docs/runbooks/live-spikes.md` spike #1 to run it for real, and
 * `tests/contract/zoho-workdrive-wire.test.ts` for the offline `MockAgent` wire-shape
 * tests that *do* run unconditionally.
 */

const LIVE = process.env.LIVE_ZOHO === '1';

if (!LIVE) {
  console.warn(
    '\n[contract/file-store] LIVE_ZOHO is not set — the real FileStorePort contract leg ' +
      'is SKIPPED, not passed. Set LIVE_ZOHO=1 plus ZOHO_* credentials to run it for real ' +
      '(docs/runbooks/live-spikes.md spike #1).\n',
  );
}

function buildReal(): FileStorePort {
  return new ZohoFileStore({
    apiBase: process.env.ZOHO_API_BASE ?? '',
    clientId: process.env.ZOHO_CLIENT_ID ?? '',
    clientSecret: process.env.ZOHO_CLIENT_SECRET ?? '',
    refreshToken: process.env.ZOHO_REFRESH_TOKEN ?? '',
    teamFolderId: process.env.ZOHO_TEAM_FOLDER_ID ?? '',
    accountsBase: process.env.ZOHO_ACCOUNTS_BASE,
    linkRoleId: process.env.ZOHO_LINK_ROLE_ID ?? '6',
  });
}

const scenarios: { name: string; skip: boolean; build: () => FileStorePort }[] = [
  { name: 'fake', skip: false, build: () => new FakeFileStore() },
  { name: 'real', skip: !LIVE, build: buildReal },
];

for (const scenario of scenarios) {
  describe.skipIf(scenario.skip)(`FileStorePort contract: ${scenario.name}`, () => {
    let port: FileStorePort;

    beforeEach(() => {
      port = scenario.build();
    });

    it(
      'uploads a file, creates a public link, round-trips the bytes via openDownload, then revokes and deletes',
      async () => {
        const content = Buffer.from('zoho contract test payload');
        const { resourceId } = await port.upload(
          'contract-tenant',
          Readable.from(content),
          content.length,
          'contract-test.txt',
        );
        expect(resourceId).toBeTruthy();

        const link = await port.createPublicLink(resourceId, { allowDownload: true });
        expect(link.linkId).toBeTruthy();
        expect(link.url).toBeTruthy();
        expect(link.embedToken).toBeTruthy();

        const stream = await port.openDownload(resourceId);
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
        }
        expect(Buffer.concat(chunks).equals(content)).toBe(true);

        await port.revokeLink(link.linkId);
        await port.delete(resourceId);
      },
      scenario.name === 'real' ? 60_000 : undefined,
    );
  });
}

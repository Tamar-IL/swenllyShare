import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DriveSharePort } from '../../src/ports/drive-share.js';
import { FakeDriveShare } from '../../src/adapters/google/fake.js';
import { GoogleDriveShare } from '../../src/adapters/google/real.js';

/**
 * `DriveSharePort` contract suite, run against both adapters (architecture.md §2, §9 item
 * 4). The `real` leg only runs with `LIVE_GOOGLE=1` plus real Google credentials — neither
 * is available in this environment (no live credentials anywhere in this repo), so it
 * reports **skipped, not passed**, per architecture.md §9's honesty rule. See
 * `docs/runbooks/live-spikes.md` spike #2 to run it for real, and
 * `tests/contract/google-drive-wire.test.ts` for the offline `MockAgent` wire-shape tests
 * that *do* run unconditionally.
 */

const LIVE = process.env.LIVE_GOOGLE === '1';

if (!LIVE) {
  console.warn(
    '\n[contract/drive-share] LIVE_GOOGLE is not set — the real DriveSharePort contract ' +
      'leg is SKIPPED, not passed. Set LIVE_GOOGLE=1 plus GOOGLE_* credentials to run it ' +
      'for real (docs/runbooks/live-spikes.md spike #2).\n',
  );
}

function buildReal(): DriveSharePort {
  return new GoogleDriveShare({
    credentialMode:
      (process.env.GOOGLE_CREDENTIAL_MODE as 'service_account' | 'oauth_refresh' | undefined) ??
      'service_account',
    saJsonPath: process.env.GOOGLE_SA_JSON_PATH,
    impersonateSubject: process.env.GOOGLE_IMPERSONATE_SUBJECT,
    sharedDriveId: process.env.GOOGLE_SHARED_DRIVE_ID,
    rootFolderId: process.env.GOOGLE_ROOT_FOLDER_ID,
    oauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    oauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    oauthRefreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
  });
}

const scenarios: { name: string; skip: boolean; build: () => DriveSharePort }[] = [
  { name: 'fake', skip: false, build: () => new FakeDriveShare() },
  { name: 'real', skip: !LIVE, build: buildReal },
];

for (const scenario of scenarios) {
  describe.skipIf(scenario.skip)(`DriveSharePort contract: ${scenario.name}`, () => {
    let port: DriveSharePort;

    beforeEach(() => {
      port = scenario.build();
    });

    it(
      'uploads a file, copies it under an intent key recoverable by findByIntent, and grants + revokes a permission',
      async () => {
        const content = Buffer.from('drive contract test payload');
        const { driveFileId } = await port.uploadResumable(
          `contract-test-tenant-${scenario.name}`,
          Readable.from(content),
          content.length,
          'contract-test.txt',
          'text/plain',
        );
        expect(driveFileId).toBeTruthy();

        const intentKey = `contract-test:${scenario.name}:${Date.now()}`;
        await expect(port.findByIntent(intentKey)).resolves.toBeUndefined();

        const { driveFileId: copyId } = await port.copy(driveFileId, intentKey);
        expect(copyId).toBeTruthy();
        await expect(port.findByIntent(intentKey)).resolves.toEqual({ driveFileId: copyId });

        const { permissionId } = await port.sharePermission(
          copyId,
          'contract-requester@example.com',
        );
        expect(permissionId).toBeTruthy();

        await port.revokeAll(copyId);
        await port.delete(copyId);
        await port.delete(driveFileId);
      },
      scenario.name === 'real' ? 60_000 : undefined,
    );
  });
}

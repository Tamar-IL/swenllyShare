import { Readable } from 'node:stream';
import type { TestContainer } from './container.js';
import { signInAsNewTenant } from './http.js';
import { runPendingJobs } from '../../src/jobs/queue.js';
import { files, type FileRow } from '../../src/db/repositories/files.js';
import { tenants, type TenantRow } from '../../src/db/repositories/tenants.js';

/** Signs in a fresh tenant and publishes one ready file for it — the common starting
 * point for every inbound-pipeline test. */
export async function createTenantWithReadyFile(
  container: TestContainer,
  email: string,
  fileParams: { originalName?: string; content?: string } = {},
): Promise<{ tenant: TenantRow; file: FileRow }> {
  const { tenantId } = await signInAsNewTenant(container, email);
  const created = await container.services.files.createStaged({
    tenantId,
    stream: Readable.from(Buffer.from(fileParams.content ?? 'hello')),
    originalName: fileParams.originalName ?? 'doc.pdf',
    mime: 'application/pdf',
  });
  await runPendingJobs(container);
  const file = (await files.findById(container.pool, tenantId, created.id))!;
  const tenant = (await tenants.findById(container.pool, tenantId))!;
  return { tenant, file };
}

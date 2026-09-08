import { beforeEach, describe, expect, it } from 'vitest';
import { hasTestDatabase, truncateAll } from '../setup/db.js';
import { buildTestContainer } from '../setup/container.js';
import { buildApp } from '../../src/app.js';
import { runPendingJobs } from '../../src/jobs/queue.js';

/**
 * `/readyz`'s sweep-health reporting (F-5, `docs/security/red-team-report.md`
 * RT-50..RT-54): "a handler that is never scheduled is not a control" — this is what
 * turns that into a fact `/readyz` can actually surface, instead of only being provable
 * by reading the source.
 */
describe.skipIf(!hasTestDatabase())('GET /readyz', () => {
  beforeEach(async () => {
    await truncateAll();
  });

  it('reports the sweeps unhealthy before any have ever been scheduled', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.sweepsHealthy).toBe(false);
    expect(body.sweeps['staging.purge'].healthy).toBe(false);
    expect(body.sweeps['staging.purge'].lastScheduledAt).toBeNull();
  });

  it('reports the sweeps healthy once the worker loop has scheduled them', async () => {
    const container = buildTestContainer();
    const app = await buildApp({ container });

    await runPendingJobs(container); // ensureSweepsScheduled runs at the start of this

    const res = await app.inject({ method: 'GET', url: '/readyz' });
    const body = res.json();
    expect(body.sweepsHealthy).toBe(true);
    for (const kind of ['staging.purge', 'inbound.purge', 'expiry.safety_sweep']) {
      expect(body.sweeps[kind].healthy).toBe(true);
      expect(body.sweeps[kind].lastScheduledAt).toBeTruthy();
    }
  });
});

import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildContainer } from './container.js';
import { startWorkerLoop } from './jobs/loop.js';

/**
 * Standalone worker-only entrypoint (architecture.md §1, §2: "worker loop toggleable by
 * env so it can be split later without a code change"). `server.ts` runs the worker
 * in-process by default (`WORKER_ENABLED=true`); running this file instead — with
 * `WORKER_ENABLED=false` on the HTTP process — splits HTTP and worker into two
 * deployables with no other code change, just process topology.
 */
async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool({ connectionString: config.DATABASE_URL, max: config.PGPOOL_MAX });

  await migrate(pool);

  const container = buildContainer({ config, pool });
  const workerLoop = startWorkerLoop(container);

  closeWithGrace({ delay: 10_000 }, async ({ err }) => {
    if (err) console.error('worker: closing due to error', err);
    await workerLoop.stop();
    await pool.end();
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

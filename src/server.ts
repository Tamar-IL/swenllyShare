import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildContainer } from './container.js';
import { buildApp } from './app.js';
import { startWorkerLoop } from './jobs/loop.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.PGPOOL_MAX,
    nodeEnv: config.NODE_ENV,
    pgSsl: config.PG_SSL,
  });

  await migrate(pool);

  const container = buildContainer({ config, pool });
  const app = await buildApp({ container });

  // Single deployable, single process (architecture.md §1): the worker loop runs
  // in-process by default, toggled off via WORKER_ENABLED so it can be split into its
  // own process later (see worker.ts) without a code change here.
  const workerLoop = config.WORKER_ENABLED ? startWorkerLoop(container) : undefined;

  closeWithGrace({ delay: 10_000 }, async ({ err }) => {
    if (err) app.log.error({ err }, 'closing due to error');
    await workerLoop?.stop();
    await app.close();
    await pool.end();
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

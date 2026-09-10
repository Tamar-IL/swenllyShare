import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildContainer } from './container.js';
import { buildApp } from './app.js';
import { startWorkerLoop } from './jobs/loop.js';
import { createLogger } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // Fix pass 7 (docs/reviews/critic-report.md Minor): built once, here, and threaded
  // through `buildContainer` so `container.logger` (jobs/domain services) and
  // `app.log` (HTTP requests, via `buildApp` passing this same instance to Fastify) are
  // the SAME pino instance — one format, one redaction list (`src/logger.ts`),
  // everywhere this process logs.
  const logger = createLogger(config.LOG_LEVEL);
  const pool = createPool({
    connectionString: config.DATABASE_URL,
    max: config.PGPOOL_MAX,
    nodeEnv: config.NODE_ENV,
    pgSsl: config.PG_SSL,
  });

  await migrate(pool);

  const container = buildContainer({ config, pool, logger });
  const app = await buildApp({ container });

  // Single deployable, single process (architecture.md §1): the worker loop runs
  // in-process by default, toggled off via WORKER_ENABLED so it can be split into its
  // own process later (see worker.ts) without a code change here.
  const workerLoop = config.WORKER_ENABLED ? startWorkerLoop(container) : undefined;

  closeWithGrace({ delay: 10_000 }, async ({ err }) => {
    if (err) container.logger.error({ err }, 'server: closing due to error');
    await workerLoop?.stop();
    await app.close();
    await pool.end();
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  // Fix pass 7 (docs/reviews/critic-report.md Minor): the one place in `src/**` (outside
  // `db/migrate.ts`'s CLI) that can't reach for `container.logger` — `main()` may have
  // failed before `loadConfig`/`buildContainer` ever ran. A bare `createLogger('fatal')`
  // still routes through pino rather than `console.error`.
  createLogger('fatal').fatal({ err }, 'server: fatal error during startup');
  process.exit(1);
});

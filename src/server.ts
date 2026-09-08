import closeWithGrace from 'close-with-grace';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool({ connectionString: config.DATABASE_URL, max: config.PGPOOL_MAX });

  await migrate(pool);

  const app = buildApp({ config, pool });

  closeWithGrace({ delay: 10_000 }, async ({ err }) => {
    if (err) app.log.error({ err }, 'closing due to error');
    await app.close();
    await pool.end();
  });

  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

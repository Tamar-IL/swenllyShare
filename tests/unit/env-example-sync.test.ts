import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');

/**
 * Fix pass 5, F-B (`docs/reviews/critic-report.md`): `.env.example` is the file
 * `docs/runbooks/run-and-deploy.md` tells the operator to copy — "anything not in it does
 * not exist operationally." Six vars were missing from it (including
 * `INBOUND_REQUESTS_ENABLED`, the F-1 kill switch itself). Diffing programmatically so a
 * future config addition that forgets `.env.example` fails CI instead of silently drifting
 * again.
 */
function extractConfigKeys(): string[] {
  const src = readFileSync(path.join(ROOT, 'src/config.ts'), 'utf8');
  const start = src.indexOf('const baseConfigSchema = z.object({');
  const end = src.indexOf('\n});', start);
  if (start === -1 || end === -1) {
    throw new Error('env-example-sync: could not locate baseConfigSchema object body in config.ts');
  }
  const body = src.slice(start, end);
  return [...body.matchAll(/^\s{2}([A-Z][A-Z0-9_]*):\s/gm)].map((m) => m[1]);
}

function extractEnvExampleKeys(): Set<string> {
  const env = readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  return new Set([...env.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

describe('.env.example stays in sync with src/config.ts', () => {
  it('every configSchema key appears in .env.example', () => {
    const configKeys = extractConfigKeys();
    expect(configKeys.length).toBeGreaterThan(30); // sanity: the extraction regex still works
    const envKeys = extractEnvExampleKeys();
    const missing = configKeys.filter((k) => !envKeys.has(k));
    expect(missing).toEqual([]);
  });
});

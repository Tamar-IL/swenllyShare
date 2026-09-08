import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'gen-verification-ledger.ts');

/**
 * The honesty ledger (architecture.md §9) is worthless if it can silently drift from the
 * `@unverified-live`/`@verified-live` markers in `src/adapters/**\/real.ts`. This test is
 * exactly what CI's `pnpm gen:ledger --check` step runs — failing here means someone
 * changed a marker (or added a real-adapter method) without regenerating
 * `docs/verification-ledger.md`.
 */
describe('verification ledger', () => {
  it('docs/verification-ledger.md is up to date with the markers in src/adapters/**/real.ts', () => {
    expect(() => {
      execFileSync('npx', ['tsx', SCRIPT, '--check'], { cwd: ROOT, stdio: 'pipe' });
    }).not.toThrow();
  });

  it('reports zero verified-live methods — no live external call has been made yet', () => {
    const ledger = readFileSync(path.join(ROOT, 'docs', 'verification-ledger.md'), 'utf8');
    expect(ledger).toMatch(/\*\*Live call summary: 0 verified-live, \d+ unverified-live\.\*\*/);
  });
});

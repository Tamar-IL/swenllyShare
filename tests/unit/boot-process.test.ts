import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { killChildOnFailedReadiness } from '../e2e/support/boot-process.js';

/**
 * Fix pass 8 (docs/reviews/code-review.md, "Polish pass review — 2026-09-10" finding 4).
 * Fast, always-runs unit test for `killChildOnFailedReadiness`
 * (`tests/e2e/support/boot-process.ts`) — the helper `tests/e2e/smoke.e2e.ts`'s
 * `bootApp()` uses to make sure a failed readiness wait kills the spawned child instead
 * of leaking it. Replaces `tests/review/e2e-bootApp-leak.probe.test.ts` (deleted), which
 * reproduced the buggy control-flow shape in isolation rather than testing the real
 * fix — this test exercises the actual helper `bootApp` calls.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check, no-op otherwise
    return true;
  } catch {
    return false;
  }
}

function spawnLongRunning() {
  return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
}

describe('killChildOnFailedReadiness', () => {
  it('kills the child and rethrows when the readiness wait throws', async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;
    expect(isPidAlive(pid)).toBe(true);

    await expect(
      killChildOnFailedReadiness(child, async () => {
        throw new Error('readiness check failed');
      }),
    ).rejects.toThrow('readiness check failed');

    await sleep(100);
    expect(isPidAlive(pid)).toBe(false);
  });

  it('leaves the child running when the readiness wait succeeds', async () => {
    const child = spawnLongRunning();
    const pid = child.pid!;

    await expect(killChildOnFailedReadiness(child, async () => {})).resolves.toBeUndefined();

    expect(isPidAlive(pid)).toBe(true);
    child.kill('SIGKILL'); // this test's own cleanup, not the thing under test
  });
});

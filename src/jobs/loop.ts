import type { Container } from '../container.js';
import { ensureSweepsScheduled, PERIODIC_SWEEP_INTERVAL_MINUTES, processNextJob } from './queue.js';

const POLL_INTERVAL_MS = 500;
// F-5: how often the worker loop re-checks that the periodic sweep kinds are scheduled.
// Deliberately shorter than PERIODIC_SWEEP_INTERVAL_MINUTES itself (dedupe means an
// early re-check is a harmless no-op) so a worker that starts mid-window still gets the
// current window's sweep enqueued promptly rather than waiting out the rest of it.
const SWEEP_CHECK_INTERVAL_MS = Math.min(PERIODIC_SWEEP_INTERVAL_MINUTES * 60_000, 60_000);

export interface WorkerLoopHandle {
  /** Resolves once every concurrent worker has finished its current job and stopped
   * picking up new ones — safe to await from a graceful-shutdown hook. */
  stop(): Promise<void>;
}

/**
 * Starts `WORKER_CONCURRENCY` (config) independent polling loops against `jobs.claimNext`
 * (architecture.md §2). Each loop claims one job at a time, processes it via
 * `processNextJob`'s shared complete/reschedule/backoff/dead-letter policy, and sleeps
 * `POLL_INTERVAL_MS` when there is nothing to do. `stop()` lets the in-flight job in every
 * loop finish before resolving — no job is abandoned mid-processing on shutdown.
 */
export function startWorkerLoop(container: Container): WorkerLoopHandle {
  let stopping = false;
  const loops: Promise<void>[] = [];

  async function runOne(): Promise<void> {
    while (!stopping) {
      let didWork: boolean;
      try {
        didWork = await processNextJob(container);
      } catch (err) {
        // processNextJob only rejects for a truly unexpected error (e.g. the pool itself
        // is down) — every handler-level failure is already caught and turned into a
        // `jobs.fail()` call. Log and back off briefly rather than spinning hot.
        console.error('worker loop: unexpected error claiming/processing a job', err);
        didWork = false;
      }
      if (!didWork) {
        await container.ports.clock.sleep(POLL_INTERVAL_MS);
      }
    }
  }

  for (let i = 0; i < container.config.WORKER_CONCURRENCY; i++) {
    loops.push(runOne());
  }

  // F-5: a dedicated, low-frequency loop (independent of WORKER_CONCURRENCY — one is
  // enough, `ensureSweepsScheduled`'s dedupe key makes a redundant call harmless) that
  // keeps `staging.purge`/`inbound.purge`/`expiry.safety_sweep` actually entering the
  // queue. Runs once immediately at startup so a freshly-started worker doesn't wait out
  // a full interval before the current window's sweep is scheduled.
  async function runSweepScheduler(): Promise<void> {
    while (!stopping) {
      try {
        await ensureSweepsScheduled(container);
      } catch (err) {
        console.error('worker loop: failed to schedule periodic sweeps', err);
      }
      await container.ports.clock.sleep(SWEEP_CHECK_INTERVAL_MS);
    }
  }
  loops.push(runSweepScheduler());

  return {
    async stop() {
      stopping = true;
      await Promise.all(loops);
    },
  };
}

import type { Container } from '../container.js';
import { jobs, type JobRow } from '../db/repositories/jobs.js';
import { files } from '../db/repositories/files.js';
import { deliveries } from '../db/repositories/deliveries.js';
import { handleFilePublish } from './handlers/file-publish.js';
import { handleDeliveryFulfill } from './handlers/delivery-fulfill.js';
import { handleFileExpire } from './handlers/file-expire.js';
import { handleDriveRevoke } from './handlers/drive-revoke.js';
import { handleStagingPurge } from './handlers/staging-purge.js';
import { handleInboundPurge } from './handlers/inbound-purge.js';
import { handleExpirySafetySweep } from './handlers/expiry-safety-sweep.js';

export const JOB_KINDS = [
  'file.publish',
  'delivery.fulfill',
  'file.expire',
  'drive.revoke',
  'staging.purge',
  'inbound.purge',
  'expiry.safety_sweep',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/**
 * F-5's periodic-sweep window: `staging.purge`, `inbound.purge`, and
 * `expiry.safety_sweep` are enqueued (deduped per window, so this is cheap to call often)
 * roughly this often. Not a promise that a purge happens exactly on this cadence — the
 * worker's normal claim/backoff timing still applies to the jobs themselves — only that
 * one gets INTO the queue this often.
 */
export const PERIODIC_SWEEP_INTERVAL_MINUTES = 15;

/** A handler either finishes the job (`done`) or defers it to a specific future time
 * without counting it as a failed attempt (`reschedule` — SharingEngine's paced
 * re-share, architecture.md §5). Throwing signals a genuine failure for the caller
 * (`processClaimedJob`) to back off and eventually dead-letter. */
export type JobHandlerResult = { status: 'done' } | { status: 'reschedule'; runAt: Date };

export type JobHandler = (
  container: Container,
  payload: Record<string, unknown>,
) => Promise<JobHandlerResult>;

const HANDLERS: Record<JobKind, JobHandler> = {
  'file.publish': handleFilePublish,
  'delivery.fulfill': handleDeliveryFulfill,
  'file.expire': handleFileExpire,
  'drive.revoke': handleDriveRevoke,
  'staging.purge': handleStagingPurge,
  'inbound.purge': handleInboundPurge,
  'expiry.safety_sweep': handleExpirySafetySweep,
};

function backoffMs(attempts: number): number {
  // Exponential backoff with a 1s floor and a 5-minute ceiling.
  return Math.min(1000 * 2 ** attempts, 5 * 60 * 1000);
}

/**
 * Runs a job kind's dead-letter cleanup — the one place per-kind compensation lives for a
 * job that has exhausted `JOB_MAX_ATTEMPTS`. `delivery.fulfill` marks its `deliveries` row
 * `failed` so the audit log never shows a permanently stuck `queued` row (architecture.md
 * §3 invariant 4); `file.publish` marks the file `failed`, surfaced on the file page with
 * a retry action (architecture.md §6).
 */
async function runDeadLetterHook(container: Container, job: JobRow): Promise<void> {
  const payload = job.payload as Record<string, unknown>;
  if (job.kind === 'file.publish') {
    const tenantId = String(payload.tenantId ?? '');
    const fileId = String(payload.fileId ?? '');
    if (tenantId && fileId) {
      // Code review finding 1/4 (docs/reviews/code-review.md): `handleFilePublish`'s own
      // `status === 'deleted'` guard (src/domain/files.ts publishFile) should already
      // stop this from ever dead-lettering going forward, but this hook re-reads the
      // file and no-ops anyway as the belt-and-braces of last resort — e.g. a job that
      // was already deep into its retry count before this fix shipped, or any other
      // future job kind reusing this hook's shape. Never downgrade an already-deleted
      // file back to `failed`.
      const file = await files.findById(container.pool, tenantId, fileId);
      if (file?.status === 'deleted') {
        console.log(
          `file.publish dead-letter hook: file ${fileId} (tenant ${tenantId}) already deleted, no-op`,
        );
        return;
      }
      await files.setPublishStep(container.pool, tenantId, fileId, { status: 'failed' });
    }
    return;
  }
  if (job.kind === 'delivery.fulfill') {
    const tenantId = String(payload.tenantId ?? '');
    const deliveryId = String(payload.deliveryId ?? '');
    if (tenantId && deliveryId) {
      await deliveries.complete(container.pool, tenantId, deliveryId, {
        outcome: 'failed',
        reason: job.last_error ?? 'job_dead_lettered',
      });
    }
  }
}

/**
 * Claims and runs the next due job of `kinds` (default: all), applying the shared
 * complete/reschedule/fail/dead-letter policy. Returns `true` if a job was claimed and
 * processed (whether it succeeded or failed), `false` if there was nothing to do — the
 * signal both the real worker loop and `runPendingJobs` use to know when to stop.
 */
export async function processNextJob(
  container: Container,
  kinds: readonly JobKind[] = JOB_KINDS,
): Promise<boolean> {
  // F-5: "due" per whichever of (the injected Clock, real wall-clock time) is LATER.
  // Ordinary jobs default `run_after` to real insert-time `now()` — comparing against
  // that alone (the original behavior) keeps them claiming exactly as before. A job
  // scheduled from a FUTURE point on the injected Clock (`files.scheduleExpire` from
  // `expires_at`) only needs virtual time (`FakeClock.advance()` in tests) to reach it —
  // it should never depend on real wall-clock time actually elapsing, which a test can't
  // make happen. `FakeClock` starts pinned near real "now" and only moves on an explicit
  // `advance()`/`setTo()` call, so in the untouched case it's always <= real `Date.now()`
  // and this reduces to plain real-time comparison automatically.
  const dueAsOf = new Date(Math.max(container.ports.clock.now().getTime(), Date.now()));
  const job = await jobs.claimNext(container.pool, [...kinds], dueAsOf);
  if (!job) return false;

  const handler = HANDLERS[job.kind as JobKind];
  if (!handler) {
    await jobs.fail(container.pool, job.id, {
      error: `no handler registered for job kind ${job.kind}`,
      backoffMs: backoffMs(job.attempts),
      maxAttempts: container.config.JOB_MAX_ATTEMPTS,
    });
    return true;
  }

  try {
    const result = await handler(container, job.payload as Record<string, unknown>);
    if (result.status === 'reschedule') {
      await jobs.reschedule(container.pool, job.id, result.runAt);
    } else {
      await jobs.complete(container.pool, job.id);
    }
  } catch (err) {
    const failed = await jobs.fail(container.pool, job.id, {
      error: err instanceof Error ? err.message : String(err),
      backoffMs: backoffMs(job.attempts),
      maxAttempts: container.config.JOB_MAX_ATTEMPTS,
    });
    if (failed?.status === 'dead') {
      await runDeadLetterHook(container, failed);
    }
  }
  return true;
}

/**
 * F-5 (RT-53/RT-54): enqueues the periodic sweep kinds (`staging.purge`, `inbound.purge`,
 * `expiry.safety_sweep`) for the current sweep window, deduped so calling this often is
 * cheap and never piles up duplicate jobs. This is the ONLY place any production code path
 * enqueues these kinds — before this fix, nothing did, so the handlers (correct and
 * unit-proven on their own) never actually ran.
 */
export async function ensureSweepsScheduled(container: Container): Promise<void> {
  const windowMs = PERIODIC_SWEEP_INTERVAL_MINUTES * 60_000;
  const window = String(Math.floor(container.ports.clock.now().getTime() / windowMs));
  await jobs.ensureScheduled(container.pool, {
    kind: 'staging.purge',
    dedupeKey: `staging.purge:${window}`,
  });
  await jobs.ensureScheduled(container.pool, {
    kind: 'inbound.purge',
    dedupeKey: `inbound.purge:${window}`,
  });
  await jobs.ensureScheduled(container.pool, {
    kind: 'expiry.safety_sweep',
    dedupeKey: `expiry.safety_sweep:${window}`,
  });
}

/**
 * Drains every currently-claimable job synchronously — the test-only equivalent of
 * letting the worker loop run for a while. Stops as soon as `processNextJob` finds
 * nothing pending; a job a handler reschedules into the future is correctly left
 * unclaimed rather than looping forever.
 *
 * Also ensures the periodic sweep kinds are scheduled for the current window before
 * draining (`ensureSweepsScheduled`) — the real worker loop does the same on its own
 * timer (`src/jobs/loop.ts`); doing it here too means a test calling `runPendingJobs`
 * exercises the same "did the sweep actually get scheduled" path production relies on,
 * rather than only ever exercising sweep jobs it enqueued by hand.
 */
export async function runPendingJobs(
  container: Container,
  opts: { kinds?: readonly JobKind[]; maxIterations?: number } = {},
): Promise<number> {
  await ensureSweepsScheduled(container);
  const maxIterations = opts.maxIterations ?? 10_000;
  let processed = 0;
  for (let i = 0; i < maxIterations; i++) {
    const didWork = await processNextJob(container, opts.kinds ?? JOB_KINDS);
    if (!didWork) break;
    processed += 1;
  }
  return processed;
}

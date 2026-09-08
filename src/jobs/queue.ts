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

export const JOB_KINDS = [
  'file.publish',
  'delivery.fulfill',
  'file.expire',
  'drive.revoke',
  'staging.purge',
  'inbound.purge',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

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
  const job = await jobs.claimNext(container.pool, [...kinds]);
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
 * Drains every currently-claimable job synchronously — the test-only equivalent of
 * letting the worker loop run for a while. Stops as soon as `processNextJob` finds
 * nothing pending; a job a handler reschedules into the future is correctly left
 * unclaimed rather than looping forever.
 */
export async function runPendingJobs(
  container: Container,
  opts: { kinds?: readonly JobKind[]; maxIterations?: number } = {},
): Promise<number> {
  const maxIterations = opts.maxIterations ?? 10_000;
  let processed = 0;
  for (let i = 0; i < maxIterations; i++) {
    const didWork = await processNextJob(container, opts.kinds ?? JOB_KINDS);
    if (!didWork) break;
    processed += 1;
  }
  return processed;
}

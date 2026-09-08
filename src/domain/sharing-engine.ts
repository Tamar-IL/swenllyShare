import { withAdvisoryLock, withTransaction, type Pool, type PoolClient } from '../db/pool.js';
import { driveCopies, type DriveCopyRow } from '../db/repositories/drive-copies.js';
import type { DriveSharePort } from '../ports/drive-share.js';
import type { Clock } from '../ports/clock.js';
import { QuotaClassError } from '../ports/errors.js';

const LOCK_NAMESPACE = 'swenlly.share';

/**
 * Bounded retry cap for the reactive-quota loop below. Architecture.md §5's pseudocode
 * describes "retry once; a second QuotaClass → job backoff" for the common case (one
 * requester, one copy exhausted). Under real concurrency (the AC-E1/E2 proof: 50
 * `share()` calls racing on distinct connections against the same fake quota), several
 * requesters can independently discover the *same* exhausted copy and all race to
 * provision its replacement; a strictly-single retry can then still legitimately fail for
 * some of them even though the system as a whole recovers within a couple of rounds. A
 * small bounded loop absorbs that pile-up (each round is cheap: an advisory-locked
 * transaction plus one external call) while still refusing to retry forever — a request
 * that is still hitting quota after `MAX_QUOTA_RETRIES` rounds surfaces the error to the
 * caller (in production, the `delivery.fulfill` job, which backs off and retries later),
 * exactly as the architecture's "second QuotaClass → job backoff" intends. This is a
 * deliberate, documented deviation from the literal "one retry" wording — see the
 * backend-engineer's report.
 */
const MAX_QUOTA_RETRIES = 8;

export type ShareResult =
  { type: 'shared'; driveFileId: string; copyId: string } | { type: 'paced'; retryAt: Date };

export interface SharingEngineConfig {
  DRIVE_SHARE_SOFT_CAP: number;
  SHARE_PACE_MIN_INTERVAL_MS: number;
}

/**
 * Auto-duplication past Drive's opaque sharing ceiling (architecture.md §5, verbatim).
 * Two phases: phase 1 reserves a share slot under an advisory lock scoped to
 * `(tenantId, fileId)` (mutual exclusion for the *decision*, not for rows that may not
 * exist yet); phase 2 makes the external call outside the lock. `provision()` pairs the
 * lock with `ON CONFLICT DO NOTHING` + `findByIntent` so a lost or crashed lock holder is
 * always safe to retry, never double-provisions.
 */
export class SharingEngine {
  constructor(
    private readonly pool: Pool,
    private readonly driveShare: DriveSharePort,
    private readonly clock: Clock,
    private readonly config: SharingEngineConfig,
  ) {}

  async share(tenantId: string, fileId: string, requesterEmail: string): Promise<ShareResult> {
    const phase1 = await this.reserve(tenantId, fileId);
    if (phase1.type === 'paced') return phase1;
    return this.shareWithRetry(tenantId, fileId, requesterEmail, phase1.copy, 0);
  }

  /** Phase 1: reserve a share slot under the advisory lock — provisions the first copy or
   * the next one past the soft cap, applies pacing, then reserves (architecture.md §5). */
  private async reserve(
    tenantId: string,
    fileId: string,
  ): Promise<{ type: 'reserved'; copy: DriveCopyRow } | { type: 'paced'; retryAt: Date }> {
    return withTransaction(this.pool, (client) =>
      withAdvisoryLock(client, LOCK_NAMESPACE, `${tenantId}:${fileId}`, async () => {
        let copy = await driveCopies.activeCopy(client, tenantId, fileId);
        if (!copy) {
          copy = await this.provision(client, tenantId, fileId, 0);
        }
        if (copy.share_count >= this.config.DRIVE_SHARE_SOFT_CAP) {
          copy = await this.provision(client, tenantId, fileId, copy.intent_seq + 1);
        }

        if (copy.last_share_at) {
          const elapsed = this.clock.now().getTime() - copy.last_share_at.getTime();
          if (elapsed < this.config.SHARE_PACE_MIN_INTERVAL_MS) {
            const retryAt = new Date(
              copy.last_share_at.getTime() + this.config.SHARE_PACE_MIN_INTERVAL_MS,
            );
            return { type: 'paced' as const, retryAt };
          }
        }

        const reserved = await driveCopies.reserveShare(
          client,
          tenantId,
          fileId,
          copy.id,
          this.clock.now(),
        );
        return { type: 'reserved' as const, copy: reserved ?? copy };
      }),
    );
  }

  /** Phase 2 (+ reactive-quota loop): the external call outside the lock, bounded retry
   * on `QuotaClassError` by retiring the exhausted copy and provisioning its successor. */
  private async shareWithRetry(
    tenantId: string,
    fileId: string,
    requesterEmail: string,
    copy: DriveCopyRow,
    attempt: number,
  ): Promise<ShareResult> {
    if (!copy.drive_file_id) {
      throw new Error(`SharingEngine: copy ${copy.id} has no drive_file_id to share`);
    }
    try {
      await this.driveShare.sharePermission(copy.drive_file_id, requesterEmail);
      return { type: 'shared', driveFileId: copy.drive_file_id, copyId: copy.id };
    } catch (err) {
      if (!(err instanceof QuotaClassError) || attempt >= MAX_QUOTA_RETRIES) throw err;

      const nextCopy = await withTransaction(this.pool, (client) =>
        withAdvisoryLock(client, LOCK_NAMESPACE, `${tenantId}:${fileId}`, async () => {
          await driveCopies.retire(client, tenantId, fileId, copy.id, 'quota');
          const activeNow = await driveCopies.activeCopy(client, tenantId, fileId);
          const target =
            activeNow && activeNow.intent_seq > copy.intent_seq
              ? activeNow
              : await this.provision(client, tenantId, fileId, copy.intent_seq + 1);
          const reserved = await driveCopies.reserveShare(
            client,
            tenantId,
            fileId,
            target.id,
            this.clock.now(),
          );
          return reserved ?? target;
        }),
      );

      return this.shareWithRetry(tenantId, fileId, requesterEmail, nextCopy, attempt + 1);
    }
  }

  /**
   * `provision(seq)`: reserve-then-recover-then-activate, all while holding the advisory
   * lock (architecture.md §5) — `files.copy` is the one external call this codebase makes
   * inside a transaction, accepted because double-provisioning is the failure most worth
   * excluding and the `intent_seq` unique constraint + `findByIntent` recovery make even a
   * lost lock safe.
   */
  private async provision(
    client: PoolClient,
    tenantId: string,
    fileId: string,
    seq: number,
  ): Promise<DriveCopyRow> {
    const intentKey = `${tenantId}:${fileId}:${seq}`;
    const inserted = await driveCopies.insertIntent(client, {
      tenantId,
      fileId,
      intentSeq: seq,
      intentKey,
    });
    const copyRow = inserted ?? (await driveCopies.getBySeq(client, tenantId, fileId, seq));
    if (!copyRow) {
      throw new Error(`SharingEngine.provision: no row for (${tenantId}, ${fileId}, ${seq})`);
    }
    if (copyRow.status === 'active' && copyRow.drive_file_id) return copyRow;

    // findByIntent FIRST — recovers a crash between a previous attempt's `copy()` call and
    // its caller's commit, instead of creating a second Drive file for this intent.
    const existing = await this.driveShare.findByIntent(intentKey);
    let driveFileId = existing?.driveFileId;
    if (!driveFileId) {
      if (seq === 0) {
        throw new Error(
          `SharingEngine.provision: seq 0 for file ${fileId} must already exist (created by file.publish)`,
        );
      }
      const predecessor = await driveCopies.getBySeq(client, tenantId, fileId, seq - 1);
      if (!predecessor?.drive_file_id) {
        throw new Error(
          `SharingEngine.provision: predecessor seq ${seq - 1} for file ${fileId} has no drive_file_id`,
        );
      }
      const result = await this.driveShare.copy(predecessor.drive_file_id, intentKey);
      driveFileId = result.driveFileId;
    }

    const activated = await driveCopies.activate(client, tenantId, fileId, copyRow.id, driveFileId);
    return activated ?? { ...copyRow, drive_file_id: driveFileId, status: 'active' };
  }
}
